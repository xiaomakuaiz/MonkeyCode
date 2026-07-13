package loop

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/chaitin/MonkeyCode/agent/internal/provider"
)

const (
	// transcriptMaxBytes 送去摘要的对话文本上限(超出截中间,保留头尾)。
	transcriptMaxBytes = 200 * 1024
	compactMaxTokens   = 8000
)

const compactSystem = `你是编码任务的对话压缩器。把对话历史压缩成结构化摘要,后续将只凭这份摘要继续任务,因此必须无损保留:
1. 用户的原始需求与所有后续指示(逐条,不得合并丢失)
2. 已完成的操作与修改过的文件清单(路径 + 改动要点)
3. 关键发现、决策及其理由(如根因定位、方案取舍)
4. 当前进行到哪一步、明确的下一步计划
5. 未解决的问题、已知风险、验证结果(测试是否通过)
只输出摘要本身,不要评论。`

// needCompact 上次请求的输入 token 是否已越过压缩阈值。
func (e *Engine) needCompact() bool {
	if e.opts.ContextBudget <= 0 || len(e.Messages) < 2 {
		return false
	}
	return float64(e.lastInput) > float64(e.opts.ContextBudget)*e.opts.CompactThreshold
}

// compact 把当前全部对话历史压缩为一条摘要消息。
func (e *Engine) compact(ctx context.Context) error {
	e.emitter.Emit(e.builder.CompactStatus("started"))

	req := provider.Request{
		System: compactSystem,
		Messages: []provider.Message{provider.TextMessage(provider.RoleUser,
			"以下是需要压缩的对话历史:\n\n"+renderTranscript(e.Messages))},
		MaxTokens: compactMaxTokens,
	}
	res, err := provider.StreamWithRetry(ctx, e.provider, req, nil, provider.DefaultRetry())
	if err != nil {
		e.emitter.Emit(e.builder.CompactStatus("ended"))
		return fmt.Errorf("上下文压缩失败: %w", err)
	}
	summary := strings.TrimSpace(joinText(res.Message))
	if summary == "" {
		e.emitter.Emit(e.builder.CompactStatus("ended"))
		return errors.New("上下文压缩失败: 摘要为空")
	}

	e.Messages = []provider.Message{provider.TextMessage(provider.RoleUser,
		"【上下文压缩】此前对话已压缩,完整摘要如下:\n\n"+summary+
			"\n\n请基于以上摘要继续完成当前任务;若任务已完成,直接给出最终总结。")}
	e.Usage.Add(res.Usage)
	e.lastInput = 0
	e.emitter.Emit(e.builder.CompactStatus("ended"))
	return nil
}

// renderTranscript 把消息历史渲染为供摘要的纯文本。
func renderTranscript(msgs []provider.Message) string {
	var b strings.Builder
	for _, m := range msgs {
		for _, blk := range m.Content {
			switch blk.Type {
			case provider.BlockText:
				if m.Role == provider.RoleUser {
					b.WriteString("[用户] ")
				} else {
					b.WriteString("[agent] ")
				}
				b.WriteString(blk.Text)
				b.WriteString("\n")
			case provider.BlockToolUse:
				fmt.Fprintf(&b, "[工具调用] %s %s\n", blk.Name, clip(string(blk.Input), 300))
			case provider.BlockToolResult:
				status := ""
				if blk.IsError {
					status = "(失败)"
				}
				fmt.Fprintf(&b, "[工具结果%s] %s\n", status, clip(blk.Content, 600))
			}
			// thinking 块不进摘要
		}
	}
	return clipMiddle(b.String(), transcriptMaxBytes)
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// clipMiddle 超长时保留头尾、截去中间(头部有原始需求,尾部是最新进展)。
func clipMiddle(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	head := maxBytes / 3
	tail := maxBytes - head
	return s[:head] + "\n…[中间部分因过长已省略]…\n" + s[len(s)-tail:]
}

// isContextOverflow 判断错误是否为上下文超限(触发压缩后重试)。
func isContextOverflow(err error) bool {
	var he *provider.HTTPError
	if !errors.As(err, &he) {
		return false
	}
	if he.StatusCode != 400 && he.StatusCode != 413 {
		return false
	}
	body := strings.ToLower(he.Body)
	for _, kw := range []string{"context", "token", "length", "too long", "exceed", "上下文", "过长", "超出"} {
		if strings.Contains(body, kw) {
			return true
		}
	}
	return false
}
