package loop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/chaitin/MonkeyCode/agent/internal/frame"
	"github.com/chaitin/MonkeyCode/agent/internal/policy"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
)

// scriptedProvider 按脚本返回结果或错误,并记录收到的请求。
type scriptedProvider struct {
	script   []func(req provider.Request) (*provider.Result, error)
	Requests []provider.Request
}

func (s *scriptedProvider) Model() string { return "scripted" }

func (s *scriptedProvider) Stream(_ context.Context, req provider.Request, h *provider.StreamHandler) (*provider.Result, error) {
	s.Requests = append(s.Requests, req)
	if len(s.script) == 0 {
		return nil, fmt.Errorf("脚本耗尽(收到第 %d 个请求)", len(s.Requests))
	}
	fn := s.script[0]
	s.script = s.script[1:]
	res, err := fn(req)
	if err == nil && h != nil && h.OnText != nil {
		for _, b := range res.Message.Content {
			if b.Type == provider.BlockText {
				h.OnText(b.Text)
			}
		}
	}
	return res, err
}

func text(t string, usage ...int) func(provider.Request) (*provider.Result, error) {
	u := provider.Usage{InputTokens: 100, OutputTokens: 20}
	if len(usage) > 0 {
		u.InputTokens = usage[0]
	}
	return func(provider.Request) (*provider.Result, error) {
		return &provider.Result{
			Message:    provider.TextMessage(provider.RoleAssistant, t),
			StopReason: provider.StopEndTurn,
			Usage:      u,
		}, nil
	}
}

func toolCall(name, input string, usage ...int) func(provider.Request) (*provider.Result, error) {
	u := provider.Usage{InputTokens: 100, OutputTokens: 20}
	if len(usage) > 0 {
		u.InputTokens = usage[0]
	}
	return func(provider.Request) (*provider.Result, error) {
		return &provider.Result{
			Message: provider.Message{Role: provider.RoleAssistant, Content: []provider.ContentBlock{
				{Type: provider.BlockToolUse, ID: "t1", Name: name, Input: []byte(input)},
			}},
			StopReason: provider.StopToolUse,
			Usage:      u,
		}, nil
	}
}

type frameSink struct{ frames []frame.Frame }

func (f *frameSink) Emit(fr frame.Frame) { f.frames = append(f.frames, fr) }

func (f *frameSink) count(t frame.Type, kindSubstr string) int {
	n := 0
	for _, fr := range f.frames {
		if fr.Type == t && (kindSubstr == "" || strings.Contains(string(fr.Data), kindSubstr)) {
			n++
		}
	}
	return n
}

func newTestEngine(t *testing.T, p provider.Provider, opts Options) (*Engine, *frameSink) {
	t.Helper()
	sink := &frameSink{}
	eng := New(p, tools.NewRegistry(), policy.New(policy.ModeYolo, nil),
		sink, &frame.Builder{}, t.TempDir(), "test system", opts)
	return eng, sink
}

func TestRunTurn_TextOnly(t *testing.T) {
	sp := &scriptedProvider{script: []func(provider.Request) (*provider.Result, error){
		text("完成了"),
	}}
	eng, sink := newTestEngine(t, sp, Options{})
	out, err := eng.RunTurn(context.Background(), "做点事")
	if err != nil || out != "完成了" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	if sink.count(frame.TypeTaskEnded, "") != 1 {
		t.Fatal("缺少 task-ended")
	}
	if len(eng.Messages) != 2 {
		t.Fatalf("messages = %d", len(eng.Messages))
	}
}

func TestRunTurn_WithTool(t *testing.T) {
	sp := &scriptedProvider{script: []func(provider.Request) (*provider.Result, error){
		toolCall("write_file", `{"path":"a.txt","content":"hi"}`),
		text("写好了"),
	}}
	eng, sink := newTestEngine(t, sp, Options{})
	out, err := eng.RunTurn(context.Background(), "写个文件")
	if err != nil || out != "写好了" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	// 文件真实写入
	if _, err := os.Stat(filepath.Join(eng.env.Workdir, "a.txt")); err != nil {
		t.Fatal("工具未真实执行")
	}
	// 第二次请求应包含 tool_result
	last := sp.Requests[1].Messages
	found := false
	for _, m := range last {
		for _, b := range m.Content {
			if b.Type == provider.BlockToolResult && b.ToolUseID == "t1" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("第二次请求缺少 tool_result")
	}
	if sink.count(frame.TypeTaskRunning, "tool_call") == 0 {
		t.Fatal("缺少 tool_call 帧")
	}
}

func TestCompact_Threshold(t *testing.T) {
	sp := &scriptedProvider{script: []func(provider.Request) (*provider.Result, error){
		// 第 1 步:工具调用,报告 input 已达 900(预算 1000,阈值 0.8)
		toolCall("glob", `{"pattern":"*.go"}`, 900),
		// 触发压缩:摘要请求
		text("这是摘要:用户要求列出文件,已完成 glob"),
		// 压缩后继续:结束
		text("任务完成"),
	}}
	eng, sink := newTestEngine(t, sp, Options{ContextBudget: 1000})
	out, err := eng.RunTurn(context.Background(), "列出文件")
	if err != nil || out != "任务完成" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	// 压缩请求不带工具、含转写
	compactReq := sp.Requests[1]
	if len(compactReq.Tools) != 0 {
		t.Fatal("摘要请求不应带工具")
	}
	if !strings.Contains(compactReq.Messages[0].Content[0].Text, "[工具调用] glob") {
		t.Fatal("转写缺少工具调用记录")
	}
	// 压缩后历史被替换为单条摘要消息 + 最终回复
	if len(eng.Messages) != 2 {
		t.Fatalf("压缩后 messages = %d", len(eng.Messages))
	}
	if !strings.Contains(eng.Messages[0].Content[0].Text, "这是摘要") {
		t.Fatal("摘要未注入")
	}
	if sink.count(frame.TypeTaskRunning, "compact_status") != 2 {
		t.Fatal("缺少 compact started/ended 帧")
	}
}

func TestCompact_OnOverflowError(t *testing.T) {
	overflow := &provider.HTTPError{StatusCode: 400, Body: "context length exceeded"}
	sp := &scriptedProvider{script: []func(provider.Request) (*provider.Result, error){
		func(provider.Request) (*provider.Result, error) { return nil, overflow },
		text("摘要内容"),
		text("恢复后完成"),
	}}
	eng, _ := newTestEngine(t, sp, Options{ContextBudget: 100000})
	out, err := eng.RunTurn(context.Background(), "干活")
	if err != nil || out != "恢复后完成" {
		t.Fatalf("out=%q err=%v", out, err)
	}
}

func TestPolicyDenyFeedsError(t *testing.T) {
	sp := &scriptedProvider{script: []func(provider.Request) (*provider.Result, error){
		toolCall("write_file", `{"path":"a.txt","content":"x"}`),
		text("好的,不写了"),
	}}
	sink := &frameSink{}
	// 非交互 default 策略:写操作直接拒绝
	eng := New(sp, tools.NewRegistry(), policy.New(policy.ModeDefault, nil),
		sink, &frame.Builder{}, t.TempDir(), "sys", Options{})
	if _, err := eng.RunTurn(context.Background(), "写文件"); err != nil {
		t.Fatal(err)
	}
	// 拒绝应作为 is_error 的 tool_result 反馈给模型
	var denied bool
	for _, m := range sp.Requests[1].Messages {
		for _, b := range m.Content {
			if b.Type == provider.BlockToolResult && b.IsError {
				denied = true
			}
		}
	}
	if !denied {
		t.Fatal("拒绝未以 tool_result 错误反馈")
	}
}

func TestMaxStepsLimit(t *testing.T) {
	// 永远返回工具调用 → 应在步数上限处停止
	loopForever := func(provider.Request) (*provider.Result, error) {
		return &provider.Result{
			Message: provider.Message{Role: provider.RoleAssistant, Content: []provider.ContentBlock{
				{Type: provider.BlockToolUse, ID: "t", Name: "glob", Input: []byte(`{"pattern":"*"}`)},
			}},
			StopReason: provider.StopToolUse,
		}, nil
	}
	sp := &scriptedProvider{}
	for range 10 {
		sp.script = append(sp.script, loopForever)
	}
	eng, _ := newTestEngine(t, sp, Options{MaxSteps: 3})
	_, err := eng.RunTurn(context.Background(), "无限循环")
	if err == nil || !strings.Contains(err.Error(), "最大步数") {
		t.Fatalf("err = %v", err)
	}
}

// progressTool 执行期上报两条进度的桩工具。
type progressTool struct{}

func (p *progressTool) Name() string                   { return "progress_stub" }
func (p *progressTool) Description() string            { return "stub" }
func (p *progressTool) InputSchema() map[string]any    { return map[string]any{"type": "object"} }
func (p *progressTool) Title(_ json.RawMessage) string { return "进度桩" }
func (p *progressTool) Execute(_ context.Context, env *tools.Env, _ json.RawMessage) (string, error) {
	env.EmitProgress(tools.ProgressUpdate{Kind: "output", Line: "step-1"})
	env.EmitProgress(tools.ProgressUpdate{Kind: "subagent_tool", ID: "s1", Title: "读取 a.go", Status: "run"})
	return "done", nil
}

func TestRunTurn_ToolProgressChannel(t *testing.T) {
	sp := &scriptedProvider{script: []func(provider.Request) (*provider.Result, error){
		toolCall("progress_stub", `{}`),
		text("好了"),
	}}
	eng, sink := newTestEngine(t, sp, Options{})
	eng.registry.Register(&progressTool{})

	if _, err := eng.RunTurn(context.Background(), "跑"); err != nil {
		t.Fatal(err)
	}
	// 进度帧:tool_call_update{in_progress} 携带 progress 载荷,挂在 t1 上
	if sink.count(frame.TypeTaskRunning, `"line":"step-1"`) != 1 {
		t.Fatal("缺少 output 进度帧")
	}
	if sink.count(frame.TypeTaskRunning, `"title":"读取 a.go"`) != 1 {
		t.Fatal("缺少 subagent_tool 进度帧")
	}
	for _, fr := range sink.frames {
		if strings.Contains(string(fr.Data), `"progress"`) &&
			!strings.Contains(string(fr.Data), `"toolCallId":"t1"`) {
			t.Fatalf("进度帧未挂在调用方 toolCallId: %s", fr.Data)
		}
	}
	// 进度通道注入在每次调用的独立 env 上(支持并行),模板 env 保持干净
	if eng.env.Progress != nil {
		t.Fatal("模板 env 不应持有进度通道")
	}
}

// barrierTool 可并行桩工具:两次调用互相等待对方进入执行,
// 串行执行时会超时报错——以此断言引擎确实并发执行了同批调用。
type barrierTool struct {
	entered *sync.WaitGroup // 预置 Add(2)
}

func (b *barrierTool) Name() string                   { return "ptool" }
func (b *barrierTool) Description() string            { return "stub" }
func (b *barrierTool) InputSchema() map[string]any    { return map[string]any{"type": "object"} }
func (b *barrierTool) Title(_ json.RawMessage) string { return "并行桩" }
func (b *barrierTool) Parallelizable() bool           { return true }
func (b *barrierTool) Execute(_ context.Context, env *tools.Env, input json.RawMessage) (string, error) {
	var in struct {
		Tag string `json:"tag"`
	}
	_ = json.Unmarshal(input, &in)
	env.EmitProgress(tools.ProgressUpdate{Kind: "output", Line: "from-" + in.Tag})
	b.entered.Done()
	done := make(chan struct{})
	go func() { b.entered.Wait(); close(done) }()
	select {
	case <-done:
		return "ok-" + in.Tag, nil
	case <-time.After(3 * time.Second):
		return "", fmt.Errorf("同批调用未并发执行")
	}
}

// blockingTool 可并行桩工具:进入执行后阻塞到 ctx 取消(模拟长时间运行的子代理)。
type blockingTool struct {
	entered chan struct{} // 每次调用进入执行时发信号
}

func (b *blockingTool) Name() string                   { return "blocker" }
func (b *blockingTool) Description() string            { return "stub" }
func (b *blockingTool) InputSchema() map[string]any    { return map[string]any{"type": "object"} }
func (b *blockingTool) Title(_ json.RawMessage) string { return "阻塞桩" }
func (b *blockingTool) Parallelizable() bool           { return true }
func (b *blockingTool) Execute(ctx context.Context, _ *tools.Env, _ json.RawMessage) (string, error) {
	b.entered <- struct{}{}
	<-ctx.Done()
	return "", ctx.Err()
}

// TestRunTurn_InterruptKeepsToolPairing 中断发生在工具批执行中(如多个并行
// 子代理其一报错后用户取消)时,历史必须保持 tool_use/tool_result 配对完整,
// 否则落盘后会话永久无法继续(回归:继续对话报 "toolcall result 不存在")。
func TestRunTurn_InterruptKeepsToolPairing(t *testing.T) {
	sp := &scriptedProvider{script: []func(provider.Request) (*provider.Result, error){
		func(provider.Request) (*provider.Result, error) {
			return &provider.Result{
				Message: provider.Message{Role: provider.RoleAssistant, Content: []provider.ContentBlock{
					{Type: provider.BlockToolUse, ID: "t1", Name: "blocker", Input: []byte(`{}`)},
					{Type: provider.BlockToolUse, ID: "t2", Name: "blocker", Input: []byte(`{}`)},
					{Type: provider.BlockToolUse, ID: "t3", Name: "write_file", Input: []byte(`{"path":"a.txt","content":"x"}`)},
				}},
				StopReason: provider.StopToolUse,
				Usage:      provider.Usage{InputTokens: 100, OutputTokens: 20},
			}, nil
		},
	}}
	eng, _ := newTestEngine(t, sp, Options{})
	bt := &blockingTool{entered: make(chan struct{}, 2)}
	eng.registry.Register(bt)

	// 两个并行调用都进入执行后取消(串行的 write_file 尚未开始)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-bt.entered
		<-bt.entered
		cancel()
	}()
	_, err := eng.RunTurn(ctx, "并行探索然后被取消")
	if !errors.Is(err, ErrInterrupted) {
		t.Fatalf("err = %v", err)
	}

	// 历史末条必须是完整的一批 tool_result(t1..t3 各一个)
	last := eng.Messages[len(eng.Messages)-1]
	if last.Role != provider.RoleUser || len(last.Content) != 3 {
		t.Fatalf("中断后工具结果消息缺失/不完整: %+v", last)
	}
	for i, id := range []string{"t1", "t2", "t3"} {
		b := last.Content[i]
		if b.Type != provider.BlockToolResult || b.ToolUseID != id || !b.IsError {
			t.Fatalf("第 %d 个结果异常: %+v", i, b)
		}
	}

	// 中断后续聊:下一轮请求必须能构造(历史配对完整),正常结束
	sp.script = append(sp.script, text("继续完成"))
	out, err := eng.RunTurn(context.Background(), "继续")
	if err != nil || out != "继续完成" {
		t.Fatalf("中断后续聊失败: out=%q err=%v", out, err)
	}
	assertPaired(t, sp.Requests[len(sp.Requests)-1].Messages)
}

// assertPaired 校验消息序列中每个 tool_use 都有紧随其后的配对 tool_result。
func assertPaired(t *testing.T, msgs []provider.Message) {
	t.Helper()
	for i, m := range msgs {
		for _, b := range m.Content {
			if b.Type != provider.BlockToolUse {
				continue
			}
			found := false
			if i+1 < len(msgs) {
				for _, nb := range msgs[i+1].Content {
					if nb.Type == provider.BlockToolResult && nb.ToolUseID == b.ID {
						found = true
					}
				}
			}
			if !found {
				t.Fatalf("tool_use %s 无配对 tool_result(消息 %d)", b.ID, i)
			}
		}
	}
}

func TestRepairHistory(t *testing.T) {
	use := func(ids ...string) provider.Message {
		m := provider.Message{Role: provider.RoleAssistant}
		for _, id := range ids {
			m.Content = append(m.Content, provider.ContentBlock{Type: provider.BlockToolUse, ID: id, Name: "task", Input: []byte(`{}`)})
		}
		return m
	}
	res := func(ids ...string) provider.Message {
		m := provider.Message{Role: provider.RoleUser}
		for _, id := range ids {
			m.Content = append(m.Content, provider.ContentBlock{Type: provider.BlockToolResult, ToolUseID: id, Content: "ok"})
		}
		return m
	}
	userText := provider.TextMessage(provider.RoleUser, "继续")

	// 场景 1:历史完好 → 原样
	good := []provider.Message{userText, use("a"), res("a"), provider.TextMessage(provider.RoleAssistant, "done")}
	if got := RepairHistory(good); len(got) != len(good) {
		t.Fatalf("完好历史被改动: %d != %d", len(got), len(good))
	}

	// 场景 2:尾部悬空 tool_use(中断后落盘的典型形态)→ 插入合成结果消息
	broken := []provider.Message{userText, use("a", "b")}
	got := RepairHistory(broken)
	assertPaired(t, got)
	if len(got) != 3 || len(got[2].Content) != 2 {
		t.Fatalf("未补齐合成结果: %+v", got)
	}
	if !got[2].Content[0].IsError || got[2].Content[0].ToolUseID != "a" {
		t.Fatalf("合成结果异常: %+v", got[2].Content[0])
	}

	// 场景 3:悬空 tool_use 后跟用户文本(中断后已续过聊)→ 合成结果插到文本前
	broken = []provider.Message{use("a"), userText}
	got = RepairHistory(broken)
	assertPaired(t, got)
	if len(got) != 2 || got[1].Content[0].Type != provider.BlockToolResult || got[1].Content[1].Text != "继续" {
		t.Fatalf("合成结果未插入文本前: %+v", got[1])
	}

	// 场景 4:部分缺失(三个 use 只有一个 result)→ 只补缺的
	m := res("b")
	broken = []provider.Message{use("a", "b", "c"), m}
	got = RepairHistory(broken)
	assertPaired(t, got)
	if len(got[1].Content) != 3 {
		t.Fatalf("部分缺失未补齐: %+v", got[1])
	}
}

func TestRunTurn_ParallelizableToolsRunConcurrently(t *testing.T) {
	sp := &scriptedProvider{script: []func(provider.Request) (*provider.Result, error){
		func(provider.Request) (*provider.Result, error) {
			return &provider.Result{
				Message: provider.Message{Role: provider.RoleAssistant, Content: []provider.ContentBlock{
					{Type: provider.BlockToolUse, ID: "t1", Name: "ptool", Input: []byte(`{"tag":"a"}`)},
					{Type: provider.BlockToolUse, ID: "t2", Name: "ptool", Input: []byte(`{"tag":"b"}`)},
				}},
				StopReason: provider.StopToolUse,
				Usage:      provider.Usage{InputTokens: 100, OutputTokens: 20},
			}, nil
		},
		text("并行完成"),
	}}
	eng, sink := newTestEngine(t, sp, Options{})
	var wg sync.WaitGroup
	wg.Add(2)
	eng.registry.Register(&barrierTool{entered: &wg})

	out, err := eng.RunTurn(context.Background(), "并行探索")
	if err != nil || out != "并行完成" {
		t.Fatalf("out=%q err=%v", out, err)
	}

	// tool_result 按 tool_use 原顺序回填,且各自结果正确
	last := eng.Messages[len(eng.Messages)-2] // [-1] 是最终助手回复,[-2] 是工具结果
	if last.Role != provider.RoleUser || len(last.Content) != 2 {
		t.Fatalf("工具结果消息异常: %+v", last)
	}
	if last.Content[0].ToolUseID != "t1" || last.Content[0].Content != "ok-a" ||
		last.Content[1].ToolUseID != "t2" || last.Content[1].Content != "ok-b" {
		t.Fatalf("结果顺序或内容错误: %+v", last.Content)
	}

	// 并发执行时的进度帧各自挂在自己的 toolCallId 上,不串扰
	for _, fr := range sink.frames {
		s := string(fr.Data)
		if strings.Contains(s, `"line":"from-a"`) && !strings.Contains(s, `"toolCallId":"t1"`) {
			t.Fatalf("a 的进度挂错调用: %s", s)
		}
		if strings.Contains(s, `"line":"from-b"`) && !strings.Contains(s, `"toolCallId":"t2"`) {
			t.Fatalf("b 的进度挂错调用: %s", s)
		}
	}
}
