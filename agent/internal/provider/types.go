// Package provider 封装 LLM 访问:协议客户端、流式解析、tool-call 归一化与重试。
package provider

import (
	"context"
	"encoding/json"
)

// Role 消息角色。
type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// BlockType 内容块类型(对齐 Anthropic Messages 协议)。
type BlockType string

const (
	BlockText       BlockType = "text"
	BlockThinking   BlockType = "thinking"
	BlockToolUse    BlockType = "tool_use"
	BlockToolResult BlockType = "tool_result"
)

// ContentBlock 消息内容块。
type ContentBlock struct {
	Type BlockType `json:"type"`

	// text
	Text string `json:"text,omitempty"`

	// thinking(部分网关要求把 thinking 连同 signature 原样回传)
	Thinking  string `json:"thinking,omitempty"`
	Signature string `json:"signature,omitempty"`

	// tool_use
	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`

	// tool_result
	ToolUseID string `json:"tool_use_id,omitempty"`
	Content   string `json:"content,omitempty"`
	IsError   bool   `json:"is_error,omitempty"`
}

// Message 一条对话消息。
type Message struct {
	Role    Role           `json:"role"`
	Content []ContentBlock `json:"content"`
}

// TextMessage 构造纯文本消息。
func TextMessage(role Role, text string) Message {
	return Message{Role: role, Content: []ContentBlock{{Type: BlockText, Text: text}}}
}

// ToolDef 工具定义。
type ToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"input_schema"`
}

// Request 一次 LLM 请求。
type Request struct {
	System    string
	Messages  []Message
	Tools     []ToolDef
	MaxTokens int
}

// Usage token 用量。
type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// Add 累加用量。
func (u *Usage) Add(o Usage) {
	u.InputTokens += o.InputTokens
	u.OutputTokens += o.OutputTokens
}

// StopReason 停止原因。
type StopReason string

const (
	StopEndTurn   StopReason = "end_turn"
	StopToolUse   StopReason = "tool_use"
	StopMaxTokens StopReason = "max_tokens"
	StopOther     StopReason = "other"
)

// Result 一次请求的完整结果(流式聚合后)。
type Result struct {
	Message    Message
	StopReason StopReason
	Usage      Usage
}

// ToolUses 返回结果中的所有工具调用块。
func (r *Result) ToolUses() []ContentBlock {
	var out []ContentBlock
	for _, b := range r.Message.Content {
		if b.Type == BlockToolUse {
			out = append(out, b)
		}
	}
	return out
}

// StreamHandler 流式回调,任一字段可为 nil。
type StreamHandler struct {
	OnText     func(delta string)
	OnThinking func(delta string)
	OnToolUse  func(id, name string)
}

func (h *StreamHandler) text(d string) {
	if h != nil && h.OnText != nil {
		h.OnText(d)
	}
}

func (h *StreamHandler) thinking(d string) {
	if h != nil && h.OnThinking != nil {
		h.OnThinking(d)
	}
}

func (h *StreamHandler) toolUse(id, name string) {
	if h != nil && h.OnToolUse != nil {
		h.OnToolUse(id, name)
	}
}

// Provider LLM 提供方接口。
type Provider interface {
	// Stream 发起流式请求,回调增量,返回聚合结果。
	Stream(ctx context.Context, req Request, h *StreamHandler) (*Result, error)
	// Model 当前模型标识。
	Model() string
}
