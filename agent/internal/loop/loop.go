// Package loop agent 主循环:LLM ↔ 工具执行,直到轮次结束。
package loop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/chaitin/MonkeyCode/agent/internal/frame"
	"github.com/chaitin/MonkeyCode/agent/internal/policy"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
)

const (
	defaultMaxSteps = 80
	// 上下文预算(粗略):超过后拒绝继续,提示开新会话。压缩在 M3 实现。
	defaultContextBudget = 180_000
)

// Options 循环配置。
type Options struct {
	MaxSteps      int
	ContextBudget int
}

// Engine 一次会话的执行引擎。
type Engine struct {
	provider provider.Provider
	registry *tools.Registry
	policy   *policy.Engine
	emitter  frame.Emitter
	builder  *frame.Builder
	env      *tools.Env
	system   string
	opts     Options

	Messages []provider.Message // 对话历史(resume 时由外部预填)
	Usage    provider.Usage     // 累计用量
}

// New 创建引擎。
func New(p provider.Provider, reg *tools.Registry, pol *policy.Engine,
	emitter frame.Emitter, builder *frame.Builder, workdir, system string, opts Options) *Engine {
	if opts.MaxSteps <= 0 {
		opts.MaxSteps = defaultMaxSteps
	}
	if opts.ContextBudget <= 0 {
		opts.ContextBudget = defaultContextBudget
	}
	return &Engine{
		provider: p, registry: reg, policy: pol,
		emitter: emitter, builder: builder,
		env: &tools.Env{Workdir: workdir}, system: system, opts: opts,
	}
}

// ErrInterrupted 用户中断。
var ErrInterrupted = errors.New("任务被用户中断")

// RunTurn 执行一轮:用户输入 → (LLM → 工具)* → 结束。
// 返回本轮最终的 agent 文本回复。
func (e *Engine) RunTurn(ctx context.Context, userInput string) (string, error) {
	e.emitter.Emit(e.builder.TaskStarted())
	e.emitter.Emit(e.builder.UserInput(userInput))
	e.Messages = append(e.Messages, provider.TextMessage(provider.RoleUser, userInput))

	var finalText string
	for step := 0; step < e.opts.MaxSteps; step++ {
		res, err := e.callLLM(ctx)
		if err != nil {
			if ctx.Err() != nil {
				e.emitter.Emit(e.builder.TaskError(ErrInterrupted.Error()))
				return finalText, ErrInterrupted
			}
			e.emitter.Emit(e.builder.TaskError(err.Error()))
			return finalText, err
		}

		e.Messages = append(e.Messages, res.Message)
		e.Usage.Add(res.Usage)
		e.emitter.Emit(e.builder.Usage(e.opts.ContextBudget, e.Usage.InputTokens+e.Usage.OutputTokens))

		if text := joinText(res.Message); text != "" {
			finalText = text
		}

		toolUses := res.ToolUses()
		if len(toolUses) == 0 {
			if res.StopReason == provider.StopMaxTokens {
				e.emitter.Emit(e.builder.TaskError("模型输出达到 max_tokens 上限,回复可能不完整"))
			}
			e.emitter.Emit(e.builder.TaskEnded())
			return finalText, nil
		}

		// 执行全部工具调用,结果作为下一次请求的 user 消息
		var results []provider.ContentBlock
		for _, tu := range toolUses {
			if ctx.Err() != nil {
				e.emitter.Emit(e.builder.TaskError(ErrInterrupted.Error()))
				return finalText, ErrInterrupted
			}
			results = append(results, e.execToolUse(ctx, tu))
		}
		e.Messages = append(e.Messages, provider.Message{Role: provider.RoleUser, Content: results})
	}

	err := fmt.Errorf("达到单轮最大步数 %d,任务未完成", e.opts.MaxSteps)
	e.emitter.Emit(e.builder.TaskError(err.Error()))
	return finalText, err
}

func (e *Engine) callLLM(ctx context.Context) (*provider.Result, error) {
	req := provider.Request{
		System:   e.system,
		Messages: e.Messages,
		Tools:    e.registry.Defs(),
	}
	handler := &provider.StreamHandler{
		OnText:     func(d string) { e.emitter.Emit(e.builder.AgentText(d)) },
		OnThinking: func(d string) { e.emitter.Emit(e.builder.AgentThought(d)) },
	}
	cfg := provider.DefaultRetry()
	cfg.OnRetry = func(attempt int, err error) {
		e.emitter.Emit(e.builder.LLMRetry(attempt, err.Error()))
	}
	return provider.StreamWithRetry(ctx, e.provider, req, handler, cfg)
}

// execToolUse 执行单个工具调用并生成 tool_result 块(错误也以结果形式返回给模型)。
func (e *Engine) execToolUse(ctx context.Context, tu provider.ContentBlock) provider.ContentBlock {
	result := func(content string, isErr bool) provider.ContentBlock {
		return provider.ContentBlock{
			Type: provider.BlockToolResult, ToolUseID: tu.ID,
			Content: content, IsError: isErr,
		}
	}

	tool, ok := e.registry.Get(tu.Name)
	if !ok {
		return result(fmt.Sprintf("未知工具 %q,可用工具见工具列表", tu.Name), true)
	}

	var rawInput any
	_ = json.Unmarshal(tu.Input, &rawInput)
	title := tool.Title(tu.Input)
	e.emitter.Emit(e.builder.ToolCall(frame.ToolCallUpdate{
		ToolCallID: tu.ID, Title: title, Kind: tu.Name,
		Status: "in_progress", RawInput: rawInput,
	}))

	finish := func(status, output string) {
		e.emitter.Emit(e.builder.ToolCallUpdate(frame.ToolCallUpdate{
			ToolCallID: tu.ID, Title: title, Kind: tu.Name,
			Status: status, RawOutput: truncateForUI(output),
		}))
	}

	// 权限检查
	if err := e.policy.Check(ctx, policy.Request{Tool: tu.Name, Title: title, Input: tu.Input}); err != nil {
		finish("failed", err.Error())
		return result(err.Error(), true)
	}

	out, err := tool.Execute(ctx, e.env, tu.Input)
	if err != nil {
		if ctx.Err() != nil {
			finish("failed", "已中断")
			return result("工具执行被中断", true)
		}
		finish("failed", err.Error())
		return result(err.Error(), true)
	}
	finish("completed", out)
	return result(out, false)
}

func joinText(m provider.Message) string {
	var parts []string
	for _, b := range m.Content {
		if b.Type == provider.BlockText && strings.TrimSpace(b.Text) != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func truncateForUI(s string) string {
	const max = 4096
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n...[已截断]"
}
