// Package loop agent 主循环:LLM ↔ 工具执行,直到轮次结束。
package loop

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/chaitin/MonkeyCode/agent/internal/frame"
	"github.com/chaitin/MonkeyCode/agent/internal/policy"
	"github.com/chaitin/MonkeyCode/agent/internal/provider"
	"github.com/chaitin/MonkeyCode/agent/internal/tools"
)

// toolImageExts 工具产图 MIME → 扩展名(落盘命名用)。
var toolImageExts = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

// saveToolImage 把工具产出的图片字节落盘到会话工作区 .mc-agent/uploads/
// (与用户上传同目录,复用 handleGetUpload 回读端点),返回工作区相对路径。
// 命名按 toolCallId + 序号,唯一且可追溯;workdir 为空则报错(调用方降级不显示图)。
func saveToolImage(workdir, toolID string, idx int, mediaType string, data []byte) (string, error) {
	if workdir == "" {
		return "", fmt.Errorf("无工作区,跳过落盘")
	}
	dir := filepath.Join(workdir, ".mc-agent", "uploads")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	// uploads 不入库:目录内放自免疫的 .gitignore(仅首次创建)
	gi := filepath.Join(dir, ".gitignore")
	if _, err := os.Stat(gi); os.IsNotExist(err) {
		_ = os.WriteFile(gi, []byte("*\n"), 0o644)
	}
	ext := toolImageExts[mediaType]
	if ext == "" {
		ext = ".png"
	}
	name := fmt.Sprintf("shot-%s-%d%s", sanitizeToolID(toolID), idx, ext)
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		return "", err
	}
	return ".mc-agent/uploads/" + name, nil
}

// sanitizeToolID 把 toolCallId 净化为安全文件名片段(字母数字 - _)。
func sanitizeToolID(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '-' || r == '_' ||
			(r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "img"
	}
	return b.String()
}

const (
	// defaultMaxSteps 单轮步数保险丝:只防模型失控空转(上下文压缩会让
	// 死循环永远转下去,这是无人值守时唯一的总花费兜底),正常任务不该撞上。
	defaultMaxSteps = 10000
	// defaultContextBudget 上下文预算缺省值:模型未配置 context_window 时使用,
	// 输入 token 超预算 80% 触发压缩。
	defaultContextBudget = 200_000
)

// Options 循环配置。
type Options struct {
	MaxSteps      int
	ContextBudget int
	// CompactThreshold 触发压缩的输入 token 占预算比例(默认 0.8)。
	CompactThreshold float64
	// ReadRoots 工作区外允许只读访问的目录(如平台技能缓存)。
	ReadRoots []string
	// Vision 当前模型支持图片输入;false 时工具结果里的图片块降级为文本占位。
	Vision bool
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

	lastInput int // 最近一次 LLM 请求的输入 token(≈当前上下文大小)

	// emitMu 串行化帧下发:可并行工具(子代理)并发执行时,进度帧可能从
	// 多个 goroutine 同时到达,下游 emitter(终端渲染、会话日志)不必自带锁。
	emitMu sync.Mutex
	// usageMu 保护 Usage 的并发累加(并行子代理经 AddUsage 回灌用量)。
	usageMu sync.Mutex
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
	if opts.CompactThreshold <= 0 || opts.CompactThreshold >= 1 {
		opts.CompactThreshold = 0.8
	}
	return &Engine{
		provider: p, registry: reg, policy: pol,
		emitter: emitter, builder: builder,
		env: &tools.Env{Workdir: workdir, ReadRoots: opts.ReadRoots}, system: system, opts: opts,
	}
}

// ErrInterrupted 用户中断。
var ErrInterrupted = errors.New("任务被用户中断")

// emit 帧下发的唯一出口(加锁,见 emitMu)。
func (e *Engine) emit(f frame.Frame) {
	e.emitMu.Lock()
	defer e.emitMu.Unlock()
	e.emitter.Emit(f)
}

// AddUsage 并发安全的用量累加(子代理用量回灌等外部路径用)。
func (e *Engine) AddUsage(u provider.Usage) {
	e.usageMu.Lock()
	defer e.usageMu.Unlock()
	e.Usage.Add(u)
}

// SetProvider 切换 LLM 客户端(轮次之间调用;消息历史为归一化格式,
// 跨 provider 续聊安全)。调用方负责保证当前没有进行中的轮次。
func (e *Engine) SetProvider(p provider.Provider) { e.provider = p }

// SetContextBudget 切换上下文预算(随模型切换,轮次之间调用;<=0 回退默认值)。
func (e *Engine) SetContextBudget(n int) {
	if n <= 0 {
		n = defaultContextBudget
	}
	e.opts.ContextBudget = n
}

// SetVision 切换视觉能力标记(随模型切换,轮次之间调用)。
func (e *Engine) SetVision(v bool) { e.opts.Vision = v }

// ModelName 当前模型标识(展示用)。
func (e *Engine) ModelName() string { return e.provider.Model() }

// Close 释放引擎持有的资源(工具的跨调用状态等)。
func (e *Engine) Close() { e.registry.Close() }

// RunTurn 执行一轮:用户输入 → (LLM → 工具)* → 结束。
// 返回本轮最终的 agent 文本回复。
func (e *Engine) RunTurn(ctx context.Context, userInput string) (string, error) {
	e.emit(e.builder.TaskStarted())
	e.emit(e.builder.UserInput(userInput))
	e.Messages = append(e.Messages, provider.TextMessage(provider.RoleUser, userInput))

	var finalText string
	for step := 0; step < e.opts.MaxSteps; step++ {
		// 阈值触发压缩(压缩失败不中断任务,继续尝试请求)
		if e.needCompact() {
			if cerr := e.compact(ctx); cerr != nil && ctx.Err() == nil {
				e.emit(e.builder.TaskError(cerr.Error()))
			}
		}

		res, err := e.callLLM(ctx)
		// 上下文超限:压缩一次后重试本步
		if err != nil && ctx.Err() == nil && isContextOverflow(err) {
			if cerr := e.compact(ctx); cerr == nil {
				res, err = e.callLLM(ctx)
			}
		}
		if err != nil {
			if ctx.Err() != nil {
				e.emit(e.builder.TaskError(ErrInterrupted.Error()))
				return finalText, ErrInterrupted
			}
			e.emit(e.builder.TaskError(err.Error()))
			return finalText, err
		}

		e.Messages = append(e.Messages, res.Message)
		e.AddUsage(res.Usage)
		e.lastInput = res.Usage.InputTokens
		e.emit(e.builder.Usage(e.opts.ContextBudget, e.lastInput+res.Usage.OutputTokens))

		if text := joinText(res.Message); text != "" {
			finalText = text
		}

		toolUses := res.ToolUses()
		if len(toolUses) == 0 {
			if res.StopReason == provider.StopMaxTokens {
				e.emit(e.builder.TaskError("模型输出达到 max_tokens 上限,回复可能不完整"))
			}
			e.emit(e.builder.TaskEnded())
			return finalText, nil
		}

		// 执行全部工具调用,结果作为下一次请求的 user 消息。
		// 中断时 results 仍是完整一批(未执行的为中断占位)——tool_use 必须有
		// 配对的 tool_result,否则历史落盘后所有后续请求都会被 API 拒绝
		results, err := e.execBatch(ctx, toolUses)
		if len(results) > 0 {
			e.Messages = append(e.Messages, provider.Message{Role: provider.RoleUser, Content: results})
		}
		if err != nil {
			e.emit(e.builder.TaskError(err.Error()))
			return finalText, err
		}
	}

	// 步数耗尽时历史仍配对完整(每步的 tool_result 已入历史),可直接续跑
	err := fmt.Errorf("达到单轮最大步数 %d,任务未完成;回复「继续」可接着执行", e.opts.MaxSteps)
	e.emit(e.builder.TaskError(err.Error()))
	return finalText, err
}

func (e *Engine) callLLM(ctx context.Context) (*provider.Result, error) {
	req := provider.Request{
		System:   e.system,
		Messages: e.Messages,
		Tools:    e.registry.Defs(),
	}
	handler := &provider.StreamHandler{
		OnText:     func(d string) { e.emit(e.builder.AgentText(d)) },
		OnThinking: func(d string) { e.emit(e.builder.AgentThought(d)) },
	}
	cfg := provider.DefaultRetry()
	cfg.OnRetry = func(attempt int, err error) {
		e.emit(e.builder.LLMRetry(attempt, err.Error()))
	}
	return provider.StreamWithRetry(ctx, e.provider, req, handler, cfg)
}

// execBatch 执行一批工具调用,结果按 tool_use 原顺序返回。
// 可并行工具(tools.Parallelizable,如只读子代理)先并发执行——多个探索任务
// 不再互相排队;其余工具(bash/写/编辑等)在并行组结束后按序串行,保证有副作用
// 的工具之间、以及与并行组的只读执行之间互不交叠。
// 用户中断时返回 ErrInterrupted,但 results 仍是完整一批:已执行的保留真实
// 结果,未执行的补中断占位——每个 tool_use 都必须有配对的 tool_result,
// 否则消息历史损坏,会话无法继续。
func (e *Engine) execBatch(ctx context.Context, toolUses []provider.ContentBlock) ([]provider.ContentBlock, error) {
	results := make([]provider.ContentBlock, len(toolUses))

	var wg sync.WaitGroup
	for i, tu := range toolUses {
		if !e.parallelizable(tu.Name) {
			continue
		}
		wg.Add(1)
		go func(i int, tu provider.ContentBlock) {
			defer wg.Done()
			results[i] = e.execToolUse(ctx, tu)
		}(i, tu)
	}
	wg.Wait()

	for i, tu := range toolUses {
		if e.parallelizable(tu.Name) {
			continue
		}
		if ctx.Err() != nil {
			results[i] = interruptedResult(tu)
			continue
		}
		results[i] = e.execToolUse(ctx, tu)
	}
	if ctx.Err() != nil {
		return results, ErrInterrupted
	}
	return results, nil
}

// stripImageBlocks 把图片块替换为文本占位(非视觉模型用)。
func stripImageBlocks(blocks []provider.ContentBlock) []provider.ContentBlock {
	out := make([]provider.ContentBlock, 0, len(blocks))
	for _, b := range blocks {
		if b.Type == provider.BlockImage {
			out = append(out, provider.ContentBlock{
				Type: provider.BlockText,
				Text: "[图片内容不可见:当前模型未开启图片支持。可在设置里为该模型勾选“支持图片”,或改用工具按文件路径处理]",
			})
			continue
		}
		out = append(out, b)
	}
	return out
}

// interruptedResult 未执行(或未执行完)的调用在中断时的占位结果。
func interruptedResult(tu provider.ContentBlock) provider.ContentBlock {
	return provider.ContentBlock{
		Type: provider.BlockToolResult, ToolUseID: tu.ID,
		Content: "工具执行被中断", IsError: true,
	}
}

// parallelizable 工具是否声明了可并行执行(未注册的工具走串行路径报错)。
func (e *Engine) parallelizable(name string) bool {
	t, ok := e.registry.Get(name)
	if !ok {
		return false
	}
	p, ok := t.(tools.Parallelizable)
	return ok && p.Parallelizable()
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
	e.emit(e.builder.ToolCall(frame.ToolCallUpdate{
		ToolCallID: tu.ID, Title: title, Kind: tu.Name,
		Status: "in_progress", RawInput: rawInput,
	}))

	finish := func(status, output string) {
		e.emit(e.builder.ToolCallUpdate(frame.ToolCallUpdate{
			ToolCallID: tu.ID, Title: title, Kind: tu.Name,
			Status: status, RawOutput: truncateForUI(output),
		}))
	}

	// 权限检查
	if err := e.policy.Check(ctx, policy.Request{Tool: tu.Name, Title: title, Input: tu.Input}); err != nil {
		finish("failed", err.Error())
		return result(err.Error(), true)
	}

	// 每次调用独立 env:进度通道闭包捕获本次 toolCallId,可并行工具并发执行时
	// 各自的进度互不串扰(子代理探索步骤、bash 实时输出等)
	env := &tools.Env{
		Workdir:   e.env.Workdir,
		ReadRoots: e.env.ReadRoots,
		Progress: func(p tools.ProgressUpdate) {
			e.emit(e.builder.ToolCallUpdate(frame.ToolCallUpdate{
				ToolCallID: tu.ID, Kind: tu.Name,
				Status: "in_progress", Progress: p,
			}))
		},
	}

	// 富内容工具(BlocksTool,如 read_file 读图)结果为块列表;单文本块压平回
	// 普通字符串结果,保持历史形状简单
	if bt, ok := tool.(tools.BlocksTool); ok {
		blocks, display, err := bt.ExecuteBlocks(ctx, env, tu.Input)
		if err != nil {
			if ctx.Err() != nil {
				finish("failed", "已中断")
				return result("工具执行被中断", true)
			}
			finish("failed", err.Error())
			return result(err.Error(), true)
		}
		// 图片块落盘一份供 UI 展示(截图/读图);在 stripImageBlocks 之前取字节,
		// 使非视觉模型下截图仍能在对话框显示。字节只落盘,帧里只带路径引用。
		var images []string
		for i, blk := range blocks {
			if blk.Type != provider.BlockImage || blk.Source == nil {
				continue
			}
			raw, derr := base64.StdEncoding.DecodeString(blk.Source.Data)
			if derr != nil {
				continue
			}
			if p, serr := saveToolImage(e.env.Workdir, tu.ID, i, blk.Source.MediaType, raw); serr == nil {
				images = append(images, p)
			}
		}
		// 非视觉模型:图片块降级为文本占位——不发 base64(网关要么报错,
		// 要么把它当文本灌进上下文,烧 token 且模型读不懂)
		if !e.opts.Vision {
			blocks = stripImageBlocks(blocks)
		}
		e.emit(e.builder.ToolCallUpdate(frame.ToolCallUpdate{
			ToolCallID: tu.ID, Title: title, Kind: tu.Name,
			Status: "completed", RawOutput: truncateForUI(display), Images: images,
		}))
		if len(blocks) == 1 && blocks[0].Type == provider.BlockText {
			return result(blocks[0].Text, false)
		}
		return provider.ContentBlock{Type: provider.BlockToolResult, ToolUseID: tu.ID, Blocks: blocks}
	}

	out, err := tool.Execute(ctx, env, tu.Input)
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
