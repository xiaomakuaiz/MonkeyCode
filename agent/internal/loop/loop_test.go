package loop

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
