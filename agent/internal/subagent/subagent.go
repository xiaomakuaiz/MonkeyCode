// Package subagent 只读探索型子代理:`task` 工具。
//
// 主 agent 把开放式的探索/检索任务(如"找出鉴权逻辑在哪、怎么工作")委托给
// 子代理,子代理在独立上下文里用只读工具(read_file/grep/glob/git)探索,
// 只把结论文本返回主上下文——中间翻阅的大量文件内容不进主上下文,
// 显著降低长任务的上下文压力。
//
// 可观测性(两层结构):
//   - 进度通道(B):子代理的工具调用被压缩成 ProgressUpdate 经 Env.Progress
//     上报,挂在主流程 task 工具调用的 tool_call_update{in_progress} 上;
//     文本/思考流不透传,主上下文不被挤占。
//   - 子会话(C):子代理的完整帧流落盘为真实子会话(meta.Parent=主会话),
//     可独立回放;childSessionId 经进度通道公告,serve 的观察者可实时跟看。
//
// 边界:工具集只读(read_file/grep/glob/git,无 bash/写/编辑)→ yolo 无权限
// 旁路;不含 task 自身 → 无递归;用量经 OnUsage 回灌主引擎。
package subagent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"

	"github.com/chaitin/MonkeyCode/agent/internal/frame"
	"github.com/chaitin/MonkeyCode/agent/internal/loop"
	"github.com/chaitin/MonkeyCode/agent/internal/policy"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/session"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
)

// defaultMaxSteps 子代理步数保险丝(小于主任务的 500,但需容纳大仓库的
// 深入调研;步数耗尽时部分结论仍会返回,见 Execute)。
const defaultMaxSteps = 200

// Tool 实现 tools.Tool,把探索任务委托给独立子代理执行。
type Tool struct {
	// Provider LLM 客户端(与主引擎共用实例,客户端无状态)。
	Provider provider.Provider
	// MaxSteps 子代理步数上限,<=0 用默认值。
	MaxSteps int
	// OnUsage 子代理用量回灌(主引擎累计),可为 nil。
	OnUsage func(provider.Usage)

	// SessionRoot 子会话存储根目录;空则不持久化子会话(如 --no-session)。
	SessionRoot string
	// ParentID 主会话 ID,写入子会话 meta.Parent;随 SessionRoot 一起使用。
	ParentID string
	// OnChildFrame 子会话帧的实时外发钩子(serve 用于向子会话观察者广播),
	// 在帧落盘后调用;可为 nil。
	OnChildFrame func(childID string, f frame.Frame)
}

type taskInput struct {
	Description string `json:"description"`
	Prompt      string `json:"prompt"`
}

func (t *Tool) Name() string { return "task" }

// Parallelizable 子代理只读且实例无跨调用可变状态,同一批多个 task
// 调用可并发执行(每次 Execute 自建注册表/引擎/子会话,互不共享)。
func (t *Tool) Parallelizable() bool { return true }

func (t *Tool) Description() string {
	return "把开放式的探索/检索任务委托给只读子代理,返回结论文本。适用:跨多文件的搜索与理解" +
		"(如\"X 功能在哪实现、如何工作\")、需要翻阅大量文件但只需要结论的调研。" +
		"不适用:已知具体文件的直接读取(直接用 read_file)、任何修改操作(子代理无写能力)。" +
		"prompt 要自包含:子代理看不到当前对话,须写清要找什么、返回什么。" +
		"多个互不依赖的探索任务应在同一次回复中一起发起(多个 task 调用会并行执行)。"
}

func (t *Tool) InputSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"description": map[string]any{"type": "string", "description": "任务的一句话描述(用于展示)"},
			"prompt":      map[string]any{"type": "string", "description": "给子代理的完整任务指令(自包含,含期望的返回形式)"},
		},
		"required": []string{"description", "prompt"},
	}
}

func (t *Tool) Title(input json.RawMessage) string {
	var in taskInput
	_ = json.Unmarshal(input, &in)
	if in.Description == "" {
		return "子代理探索"
	}
	return "子代理探索: " + in.Description
}

func (t *Tool) Execute(ctx context.Context, env *tools.Env, input json.RawMessage) (string, error) {
	var in taskInput
	if err := json.Unmarshal(input, &in); err != nil {
		return "", fmt.Errorf("task 参数解析失败: %w", err)
	}
	if strings.TrimSpace(in.Prompt) == "" {
		return "", fmt.Errorf("task 需要非空的 prompt")
	}

	// 只读工具集:无 bash/写/编辑/todo,也不含 task 自身(防递归)
	reg := tools.NewEmptyRegistry()
	for _, tl := range []tools.Tool{&tools.ReadFile{}, &tools.Grep{}, &tools.Glob{}, &tools.Git{}} {
		reg.Register(tl)
	}

	maxSteps := t.MaxSteps
	if maxSteps <= 0 {
		maxSteps = defaultMaxSteps
	}

	// 帧消费链:进度映射(B)+ 可选的子会话落盘与实时外发(C)
	emitters := frame.MultiEmitter{newProgressMapper(env)}
	childSess := t.openChildSession(env, in.Description)
	if childSess != nil {
		emitters = append(frame.MultiEmitter{childSess}, emitters...) // 先落盘再外发
		if t.OnChildFrame != nil {
			id := childSess.Meta.ID
			emitters = append(emitters, frame.EmitterFunc(func(f frame.Frame) {
				t.OnChildFrame(id, f)
			}))
		}
		env.EmitProgress(tools.ProgressUpdate{Kind: "child_session", ChildSessionID: childSess.Meta.ID})
	}

	engine := loop.New(t.Provider, reg, policy.New(policy.ModeYolo, nil),
		emitters, &frame.Builder{}, env.Workdir, systemPrompt(env.Workdir),
		loop.Options{MaxSteps: maxSteps, ReadRoots: env.ReadRoots})

	out, err := engine.RunTurn(ctx, in.Prompt)
	if t.OnUsage != nil {
		t.OnUsage(engine.Usage)
	}
	t.closeChildSession(childSess, engine, err)
	if err != nil {
		if out != "" {
			// 已产出部分结论(如步数耗尽前的最后文本):附错误一并返回,不浪费探索
			return fmt.Sprintf("%s\n\n[子代理提前终止: %v]", out, err), nil
		}
		return "", fmt.Errorf("子代理执行失败: %w", err)
	}
	if strings.TrimSpace(out) == "" {
		return "[子代理未返回内容]", nil
	}
	return out, nil
}

// openChildSession 创建子会话(C):meta.Parent 指向主会话,列表默认隐藏。
// 创建失败只降级(不落盘继续执行),不阻塞探索。
func (t *Tool) openChildSession(env *tools.Env, title string) *session.Session {
	if t.SessionRoot == "" {
		return nil
	}
	s, err := session.New(t.SessionRoot, env.Workdir, t.Provider.Model(), title)
	if err != nil {
		fmt.Fprintln(os.Stderr, "警告: 子会话创建失败(继续执行,不落盘):", err)
		return nil
	}
	s.Meta.Parent = t.ParentID
	s.Meta.Status = "running"
	if err := s.SaveMeta(); err != nil {
		fmt.Fprintln(os.Stderr, "警告: 子会话元信息保存失败:", err)
	}
	return s
}

func (t *Tool) closeChildSession(s *session.Session, engine *loop.Engine, runErr error) {
	if s == nil {
		return
	}
	if err := s.SaveMessages(engine.Messages); err != nil {
		fmt.Fprintln(os.Stderr, "警告: 子会话消息保存失败:", err)
	}
	s.Meta.Turns = 1
	s.Meta.Usage = engine.Usage
	s.Meta.Status = "finished"
	if runErr != nil {
		s.Meta.Status = "error"
	}
	if err := s.SaveMeta(); err != nil {
		fmt.Fprintln(os.Stderr, "警告: 子会话元信息保存失败:", err)
	}
	s.Close()
}

// progressMapper 把子代理帧流压缩为主流程的进度项(B):透传工具调用的
// 开始/终态,回复文本按行上抛(思考流不上抛)。env 是主引擎的执行环境
// (其 Progress 由主 loop 注入并挂在 task 调用的 toolCallId 上)。
type progressMapper struct {
	env *tools.Env
	buf strings.Builder // 未满一行的回复文本(流式增量跨 chunk 拼接)
}

func newProgressMapper(env *tools.Env) frame.Emitter {
	return &progressMapper{env: env}
}

// textLineMax 单条文本进度的长度上限(超出截断,完整文本在子会话里)。
const textLineMax = 200

func (m *progressMapper) Emit(f frame.Frame) {
	switch f.Type {
	case frame.TypeTaskEnded, frame.TypeTaskError:
		m.flushText() // 轮次结束,冲刷未满一行的尾巴(通常是结论最后一行)
		return
	case frame.TypeTaskRunning:
	default:
		return
	}
	if f.Kind != frame.KindACPEvent {
		return
	}
	var u struct {
		Update struct {
			SessionUpdate string `json:"sessionUpdate"`
			ToolCallID    string `json:"toolCallId"`
			Title         string `json:"title"`
			Status        string `json:"status"`
			Content       struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"update"`
	}
	if json.Unmarshal(f.Data, &u) != nil {
		return
	}
	up := u.Update
	switch up.SessionUpdate {
	case "agent_message_chunk":
		m.addText(up.Content.Text)
	case "tool_call":
		m.flushText() // 文本先于工具调用,保持时间顺序
		m.env.EmitProgress(tools.ProgressUpdate{
			Kind: "subagent_tool", ID: up.ToolCallID, Title: up.Title, Status: "run",
		})
	case "tool_call_update":
		if up.Status == "in_progress" {
			return // 子代理内部的进度不再向上嵌套
		}
		status := "ok"
		if up.Status == "failed" {
			status = "fail"
		}
		m.env.EmitProgress(tools.ProgressUpdate{
			Kind: "subagent_tool", ID: up.ToolCallID, Title: up.Title, Status: status,
		})
	}
}

// addText 累积流式文本增量,每凑满一行上抛一条 subagent_text 进度。
func (m *progressMapper) addText(delta string) {
	m.buf.WriteString(delta)
	for {
		line, rest, ok := strings.Cut(m.buf.String(), "\n")
		if !ok {
			return
		}
		m.emitLine(line)
		m.buf.Reset()
		m.buf.WriteString(rest)
	}
}

func (m *progressMapper) flushText() {
	m.emitLine(m.buf.String())
	m.buf.Reset()
}

func (m *progressMapper) emitLine(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	if r := []rune(line); len(r) > textLineMax {
		line = string(r[:textLineMax]) + "…"
	}
	m.env.EmitProgress(tools.ProgressUpdate{Kind: "subagent_text", Line: line})
}

func systemPrompt(workdir string) string {
	return fmt.Sprintf(`你是只读探索子代理,任务是在代码仓库中检索与理解,向委托方返回结论。

# 环境
- 操作系统: %s/%s
- 工作区: %s

# 工作方式
- 只有只读工具(read_file/grep/glob/git),不能修改任何文件、不能执行命令。
- 高效探索:先 grep/glob 缩小范围,再精读关键文件;避免逐文件通读。
- 最终回复就是交付物:直接给出结论(含关键文件路径与行号),自包含、不啰嗦,
  不要复述探索过程,不要向委托方提问。`,
		runtime.GOOS, runtime.GOARCH, workdir)
}
