package subagent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chaitin/MonkeyCode/agent/internal/frame"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/session"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
)

// scripted 按脚本返回结果的 Provider。
type scripted struct {
	script   []func(req provider.Request) (*provider.Result, error)
	requests []provider.Request
}

func (s *scripted) Model() string { return "scripted" }

func (s *scripted) Stream(_ context.Context, req provider.Request, _ *provider.StreamHandler) (*provider.Result, error) {
	s.requests = append(s.requests, req)
	if len(s.script) == 0 {
		return nil, fmt.Errorf("脚本耗尽")
	}
	fn := s.script[0]
	s.script = s.script[1:]
	return fn(req)
}

func textResp(t string) func(provider.Request) (*provider.Result, error) {
	return func(provider.Request) (*provider.Result, error) {
		return &provider.Result{
			Message:    provider.TextMessage(provider.RoleAssistant, t),
			StopReason: provider.StopEndTurn,
			Usage:      provider.Usage{InputTokens: 100, OutputTokens: 20},
		}, nil
	}
}

func toolResp(name, input string) func(provider.Request) (*provider.Result, error) {
	return func(provider.Request) (*provider.Result, error) {
		return &provider.Result{
			Message: provider.Message{
				Role: provider.RoleAssistant,
				Content: []provider.ContentBlock{{
					Type: provider.BlockToolUse, ID: "t1", Name: name, Input: json.RawMessage(input),
				}},
			},
			StopReason: provider.StopToolUse,
			Usage:      provider.Usage{InputTokens: 100, OutputTokens: 20},
		}, nil
	}
}

func run(t *testing.T, tool *Tool, workdir, prompt string) (string, error) {
	t.Helper()
	input, _ := json.Marshal(taskInput{Description: "测试", Prompt: prompt})
	return tool.Execute(context.Background(), &tools.Env{Workdir: workdir}, input)
}

func TestExecuteExploreAndAnswer(t *testing.T) {
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, "auth.go"), []byte("package auth\n// 鉴权入口\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	p := &scripted{script: []func(provider.Request) (*provider.Result, error){
		toolResp("read_file", `{"path":"auth.go"}`),
		textResp("鉴权逻辑在 auth.go:2"),
	}}
	var usage provider.Usage
	tool := &Tool{Provider: p, OnUsage: func(u provider.Usage) { usage.Add(u) }}

	out, err := run(t, tool, workdir, "找出鉴权逻辑位置")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if out != "鉴权逻辑在 auth.go:2" {
		t.Fatalf("out: %q", out)
	}
	if usage.InputTokens != 200 || usage.OutputTokens != 40 {
		t.Fatalf("usage 未回灌: %+v", usage)
	}
	// 子代理系统提示是独立的探索提示,且首条请求带上任务指令
	if len(p.requests) != 2 || !strings.Contains(p.requests[0].System, "只读探索子代理") {
		t.Fatalf("subagent system: %+v", p.requests[0].System)
	}
	// 工具列表只含只读工具,且不含 task 自身(防递归)
	names := map[string]bool{}
	for _, d := range p.requests[0].Tools {
		names[d.Name] = true
	}
	for _, banned := range []string{"task", "bash", "write_file", "edit_file", "todo"} {
		if names[banned] {
			t.Fatalf("子代理不应有工具 %q: %+v", banned, names)
		}
	}
	for _, want := range []string{"read_file", "grep", "glob", "git"} {
		if !names[want] {
			t.Fatalf("子代理缺少工具 %q: %+v", want, names)
		}
	}
}

func TestExecuteWriteToolUnavailable(t *testing.T) {
	p := &scripted{script: []func(provider.Request) (*provider.Result, error){
		toolResp("write_file", `{"path":"x.txt","content":"pwn"}`),
		textResp("好的,我没有写能力"),
	}}
	tool := &Tool{Provider: p}
	workdir := t.TempDir()
	out, err := run(t, tool, workdir, "写个文件")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if out != "好的,我没有写能力" {
		t.Fatalf("out: %q", out)
	}
	if _, err := os.Stat(filepath.Join(workdir, "x.txt")); !os.IsNotExist(err) {
		t.Fatal("子代理不应能写文件")
	}
}

func TestExecuteEmptyPrompt(t *testing.T) {
	tool := &Tool{Provider: &scripted{}}
	if _, err := run(t, tool, t.TempDir(), "  "); err == nil {
		t.Fatal("空 prompt 应报错")
	}
}

func TestExecutePartialOutputOnError(t *testing.T) {
	// 有部分结论后 provider 出错:结论应携带终止说明返回,而不是丢弃
	p := &scripted{script: []func(provider.Request) (*provider.Result, error){
		func(provider.Request) (*provider.Result, error) {
			return &provider.Result{
				Message: provider.Message{
					Role: provider.RoleAssistant,
					Content: []provider.ContentBlock{
						{Type: provider.BlockText, Text: "初步结论:在 a.go"},
						{Type: provider.BlockToolUse, ID: "t1", Name: "read_file", Input: json.RawMessage(`{"path":"a.go"}`)},
					},
				},
				StopReason: provider.StopToolUse,
				Usage:      provider.Usage{InputTokens: 100, OutputTokens: 20},
			}, nil
		},
		// 第二步 provider 直接报错
	}}
	tool := &Tool{Provider: p}
	out, err := run(t, tool, t.TempDir(), "找一下")
	if err != nil {
		t.Fatalf("有部分结论时不应报错: %v", err)
	}
	if !strings.Contains(out, "初步结论") || !strings.Contains(out, "提前终止") {
		t.Fatalf("out: %q", out)
	}
}

func TestExecuteChildSessionAndProgress(t *testing.T) {
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, "a.go"), []byte("package a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	p := &scripted{script: []func(provider.Request) (*provider.Result, error){
		toolResp("read_file", `{"path":"a.go"}`),
		textResp("结论"),
	}}

	root := t.TempDir()
	var published []frame.Frame
	tool := &Tool{
		Provider:    p,
		SessionRoot: root,
		ParentID:    "parent-123",
		OnChildFrame: func(id string, f frame.Frame) {
			published = append(published, f)
		},
	}

	var progress []tools.ProgressUpdate
	env := &tools.Env{Workdir: workdir, Progress: func(u tools.ProgressUpdate) { progress = append(progress, u) }}
	input, _ := json.Marshal(taskInput{Description: "探索", Prompt: "看看 a.go"})
	out, err := tool.Execute(context.Background(), env, input)
	if err != nil || out != "结论" {
		t.Fatalf("out=%q err=%v", out, err)
	}

	// 进度:child_session 公告 + read_file 的 run/ok
	var childID string
	var runSeen, okSeen bool
	for _, u := range progress {
		switch u.Kind {
		case "child_session":
			childID = u.ChildSessionID
		case "subagent_tool":
			if u.Status == "run" {
				runSeen = true
			}
			if u.Status == "ok" {
				okSeen = true
			}
			if !strings.Contains(u.Title, "读取") {
				t.Fatalf("进度标题: %q", u.Title)
			}
		}
	}
	if childID == "" || !runSeen || !okSeen {
		t.Fatalf("进度不完整: %+v", progress)
	}

	// 子会话落盘:meta.Parent 指向主会话,事件可回放,状态 finished
	meta, err := session.ReadMeta(root, childID)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Parent != "parent-123" || meta.Status != "finished" || meta.Title != "探索" {
		t.Fatalf("child meta: %+v", meta)
	}
	events, err := os.ReadFile(session.EventsPathFor(root, childID))
	if err != nil || len(events) == 0 {
		t.Fatalf("子会话事件日志为空: %v", err)
	}
	if !strings.Contains(string(events), "task-started") {
		t.Fatal("事件日志缺少 task-started")
	}
	// OnChildFrame 实时外发与落盘条数一致
	lines := strings.Count(strings.TrimSpace(string(events)), "\n") + 1
	if len(published) != lines {
		t.Fatalf("外发帧 %d 条 != 落盘 %d 条", len(published), lines)
	}
}

// TestProgressMapperTextLines 回复文本按行上抛:凑满一行即发、
// 工具调用前与轮次结束时冲刷残余、空行跳过、超长截断。
func TestProgressMapperTextLines(t *testing.T) {
	var progress []tools.ProgressUpdate
	env := &tools.Env{Progress: func(u tools.ProgressUpdate) { progress = append(progress, u) }}
	m := newProgressMapper(env)
	b := &frame.Builder{}

	m.Emit(b.AgentText("我先查看"))
	m.Emit(b.AgentText("配置文件\n\n然后"))                                                                   // 跨 chunk 拼行 + 空行跳过
	m.Emit(b.ToolCall(frame.ToolCallUpdate{ToolCallID: "s1", Title: "读取 a.go", Status: "in_progress"})) // 冲刷"然后"
	m.Emit(b.ToolCallUpdate(frame.ToolCallUpdate{ToolCallID: "s1", Title: "读取 a.go", Status: "completed"}))
	m.Emit(b.AgentText("结论是 " + strings.Repeat("很长", 200))) // 超长,无换行
	m.Emit(b.TaskEnded())                                   // 轮次结束冲刷

	var got []string
	for _, u := range progress {
		switch u.Kind {
		case "subagent_text":
			got = append(got, u.Line)
		case "subagent_tool":
			got = append(got, "tool:"+u.Status)
		}
	}
	want := []string{"我先查看配置文件", "然后", "tool:run", "tool:ok"}
	if len(got) != 5 {
		t.Fatalf("进度序列长度 %d: %v", len(got), got)
	}
	for i, w := range want {
		if got[i] != w {
			t.Fatalf("第 %d 条 = %q, want %q", i, got[i], w)
		}
	}
	last := got[4]
	if !strings.HasPrefix(last, "结论是") || !strings.HasSuffix(last, "…") || len([]rune(last)) > textLineMax+1 {
		t.Fatalf("超长行未截断: len=%d", len([]rune(last)))
	}
}

func TestExecuteNoSessionRootDegrades(t *testing.T) {
	p := &scripted{script: []func(provider.Request) (*provider.Result, error){textResp("ok")}}
	tool := &Tool{Provider: p} // 无 SessionRoot:不落盘
	var progress []tools.ProgressUpdate
	env := &tools.Env{Workdir: t.TempDir(), Progress: func(u tools.ProgressUpdate) { progress = append(progress, u) }}
	input, _ := json.Marshal(taskInput{Description: "d", Prompt: "p"})
	if out, err := tool.Execute(context.Background(), env, input); err != nil || out != "ok" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	for _, u := range progress {
		if u.Kind == "child_session" {
			t.Fatal("无 SessionRoot 不应公告子会话")
		}
	}
}
