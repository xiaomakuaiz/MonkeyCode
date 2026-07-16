package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// AnthropicClient Anthropic Messages 协议客户端(兼容各类 Anthropic 风格网关)。
type AnthropicClient struct {
	baseURL string
	apiKey  string
	model   string
	extra   map[string]string // 附加请求头(网关缓存亲和等)
	http    *http.Client
}

// SetExtraHeaders 设置附加请求头(每次请求都携带)。
func (c *AnthropicClient) SetExtraHeaders(h map[string]string) { c.extra = h }

// NewAnthropic 创建客户端。baseURL 形如 https://host/api/anthropic(不带 /v1/messages)。
// insecureTLS 跳过证书校验(仅自签名内网网关)。
func NewAnthropic(baseURL, apiKey, model string, insecureTLS bool) *AnthropicClient {
	return &AnthropicClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		model:   model,
		http:    newHTTPClient(insecureTLS),
	}
}

func (c *AnthropicClient) Model() string { return c.model }

type anthropicReq struct {
	Model     string      `json:"model"`
	MaxTokens int         `json:"max_tokens"`
	System    string      `json:"system,omitempty"`
	Messages  []awMessage `json:"messages"`
	Tools     []ToolDef   `json:"tools,omitempty"`
	Stream    bool        `json:"stream"`
}

// awBlock Anthropic 线上内容块。与内部 ContentBlock 的差异:tool_result 的
// content 在线上可为字符串或块数组(富内容结果,如图片),内部模型用
// Content/Blocks 两个字段表达,发送前在此归一。
type awBlock struct {
	Type      BlockType       `json:"type"`
	Text      string          `json:"text,omitempty"`
	Thinking  string          `json:"thinking,omitempty"`
	Signature string          `json:"signature,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   any             `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
	Source    *ImageSource    `json:"source,omitempty"`
}

type awMessage struct {
	Role    Role      `json:"role"`
	Content []awBlock `json:"content"`
}

func toAnthropicWire(msgs []Message) []awMessage {
	out := make([]awMessage, len(msgs))
	for i, m := range msgs {
		blocks := make([]awBlock, len(m.Content))
		for j, b := range m.Content {
			w := awBlock{
				Type: b.Type, Text: b.Text,
				Thinking: b.Thinking, Signature: b.Signature,
				ID: b.ID, Name: b.Name, Input: b.Input,
				ToolUseID: b.ToolUseID, IsError: b.IsError, Source: b.Source,
			}
			if b.Type == BlockToolResult {
				if len(b.Blocks) > 0 {
					inner := make([]awBlock, len(b.Blocks))
					for k, ib := range b.Blocks {
						inner[k] = awBlock{Type: ib.Type, Text: ib.Text, Source: ib.Source}
					}
					w.Content = inner
				} else if b.Content != "" {
					w.Content = b.Content
				}
			}
			blocks[j] = w
		}
		out[i] = awMessage{Role: m.Role, Content: blocks}
	}
	return out
}

// HTTPError 非 2xx 响应。
type HTTPError struct {
	StatusCode int
	Body       string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("llm http %d: %s", e.StatusCode, truncate(e.Body, 500))
}

// Retryable 是否可重试(限流/服务端错误)。
func (e *HTTPError) Retryable() bool {
	return e.StatusCode == 429 || e.StatusCode == 408 || e.StatusCode >= 500
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// Stream 实现 Provider。
func (c *AnthropicClient) Stream(ctx context.Context, req Request, h *StreamHandler) (*Result, error) {
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 32000
	}
	body, err := json.Marshal(anthropicReq{
		Model:     c.model,
		MaxTokens: maxTokens,
		System:    req.System,
		Messages:  toAnthropicWire(req.Messages),
		Tools:     req.Tools,
		Stream:    true,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	dumpLLMRequest(body)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("x-api-key", c.apiKey)
	httpReq.Header.Set("authorization", "Bearer "+c.apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")
	httpReq.Header.Set("accept", "text/event-stream")
	for k, v := range c.extra {
		httpReq.Header.Set(k, v)
	}

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("llm request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, &HTTPError{StatusCode: resp.StatusCode, Body: string(b)}
	}

	return parseSSE(resp.Body, h)
}

// ==================== SSE 解析 ====================

type sseEvent struct {
	Type string `json:"type"`

	// message_start
	Message *struct {
		Usage Usage `json:"usage"`
	} `json:"message,omitempty"`

	// content_block_start
	Index        int `json:"index"`
	ContentBlock *struct {
		Type      string          `json:"type"`
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Text      string          `json:"text"`
		Thinking  string          `json:"thinking"`
		Signature string          `json:"signature"`
		Input     json.RawMessage `json:"input"`
	} `json:"content_block,omitempty"`

	// content_block_delta
	Delta *struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		Thinking    string `json:"thinking"`
		PartialJSON string `json:"partial_json"`
		Signature   string `json:"signature"`
		StopReason  string `json:"stop_reason"`
	} `json:"delta,omitempty"`

	// message_delta
	Usage *Usage `json:"usage,omitempty"`

	// error
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// blockAccum 单个内容块的累积状态。
type blockAccum struct {
	block     ContentBlock
	inputJSON strings.Builder // tool_use 的 partial_json 累积
}

func parseSSE(r io.Reader, h *StreamHandler) (*Result, error) {
	res := &Result{StopReason: StopOther}
	blocks := map[int]*blockAccum{}
	order := []int{}

	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	finishBlock := func(acc *blockAccum) {
		if acc.block.Type == BlockToolUse {
			raw := strings.TrimSpace(acc.inputJSON.String())
			if raw == "" {
				raw = string(acc.block.Input)
			}
			acc.block.Input = NormalizeToolInput(raw)
		}
	}

	var gotMessageStop bool
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var ev sseEvent
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			// 容忍网关的非标准杂音行
			continue
		}

		switch ev.Type {
		case "message_start":
			if ev.Message != nil {
				res.Usage.Merge(ev.Message.Usage)
			}
		case "content_block_start":
			if ev.ContentBlock == nil {
				continue
			}
			acc := &blockAccum{}
			cb := ev.ContentBlock
			switch cb.Type {
			case "text":
				acc.block = ContentBlock{Type: BlockText, Text: cb.Text}
			case "thinking":
				acc.block = ContentBlock{Type: BlockThinking, Thinking: cb.Thinking, Signature: cb.Signature}
			case "tool_use":
				acc.block = ContentBlock{Type: BlockToolUse, ID: cb.ID, Name: cb.Name, Input: cb.Input}
				h.toolUse(cb.ID, cb.Name)
			default:
				acc.block = ContentBlock{Type: BlockType(cb.Type)}
			}
			blocks[ev.Index] = acc
			order = append(order, ev.Index)
		case "content_block_delta":
			acc := blocks[ev.Index]
			if acc == nil || ev.Delta == nil {
				continue
			}
			switch ev.Delta.Type {
			case "text_delta":
				acc.block.Text += ev.Delta.Text
				h.text(ev.Delta.Text)
			case "thinking_delta":
				acc.block.Thinking += ev.Delta.Thinking
				h.thinking(ev.Delta.Thinking)
			case "input_json_delta":
				acc.inputJSON.WriteString(ev.Delta.PartialJSON)
			case "signature_delta":
				acc.block.Signature += ev.Delta.Signature
			}
		case "content_block_stop":
			if acc := blocks[ev.Index]; acc != nil {
				finishBlock(acc)
			}
		case "message_delta":
			if ev.Delta != nil && ev.Delta.StopReason != "" {
				res.StopReason = mapStopReason(ev.Delta.StopReason)
			}
			if ev.Usage != nil {
				res.Usage.Merge(*ev.Usage)
			}
		case "message_stop":
			gotMessageStop = true
		case "error":
			msg := "stream error"
			if ev.Error != nil {
				msg = ev.Error.Message
			}
			return nil, fmt.Errorf("llm stream error: %s", msg)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read stream: %w", err)
	}
	if len(order) == 0 && !gotMessageStop {
		return nil, fmt.Errorf("llm stream ended without any content")
	}

	msg := Message{Role: RoleAssistant}
	for _, idx := range order {
		acc := blocks[idx]
		finishBlock(acc) // 幂等:防止缺 content_block_stop 的网关
		msg.Content = append(msg.Content, acc.block)
	}
	res.Message = msg
	return res, nil
}

func mapStopReason(s string) StopReason {
	switch s {
	case "end_turn", "stop_sequence":
		return StopEndTurn
	case "tool_use":
		return StopToolUse
	case "max_tokens":
		return StopMaxTokens
	default:
		return StopOther
	}
}
