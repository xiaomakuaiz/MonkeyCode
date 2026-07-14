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
	"time"
)

// OpenAIClient OpenAI Chat Completions 兼容客户端(适配大多数国产模型网关)。
// 内部统一使用 Anthropic 风格的 Message/ContentBlock 模型,请求时转换。
type OpenAIClient struct {
	baseURL string
	apiKey  string
	model   string
	extra   map[string]string // 附加请求头(网关缓存亲和等)
	http    *http.Client
}

// SetExtraHeaders 设置附加请求头(每次请求都携带)。
func (c *OpenAIClient) SetExtraHeaders(h map[string]string) { c.extra = h }

// NewOpenAI 创建客户端。baseURL 形如 https://host/v1(不带 /chat/completions)。
func NewOpenAI(baseURL, apiKey, model string) *OpenAIClient {
	return &OpenAIClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		model:   model,
		http:    &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 60 * time.Second}},
	}
}

func (c *OpenAIClient) Model() string { return c.model }

type oaiMessage struct {
	Role       string        `json:"role"`
	Content    string        `json:"content,omitempty"`
	ToolCalls  []oaiToolCall `json:"tool_calls,omitempty"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
}

type oaiToolCall struct {
	Index    *int   `json:"index,omitempty"`
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Function struct {
		Name      string `json:"name,omitempty"`
		Arguments string `json:"arguments,omitempty"`
	} `json:"function"`
}

type oaiTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Parameters  map[string]any `json:"parameters"`
	} `json:"function"`
}

type oaiReq struct {
	Model     string       `json:"model"`
	Messages  []oaiMessage `json:"messages"`
	Tools     []oaiTool    `json:"tools,omitempty"`
	MaxTokens int          `json:"max_tokens,omitempty"`
	Stream    bool         `json:"stream"`
	StreamOpt *struct {
		IncludeUsage bool `json:"include_usage"`
	} `json:"stream_options,omitempty"`
}

// convertMessages 把内部消息模型转为 OpenAI 格式。
func convertMessages(system string, msgs []Message) []oaiMessage {
	out := []oaiMessage{}
	if system != "" {
		out = append(out, oaiMessage{Role: "system", Content: system})
	}
	for _, m := range msgs {
		switch m.Role {
		case RoleAssistant:
			om := oaiMessage{Role: "assistant"}
			for _, b := range m.Content {
				switch b.Type {
				case BlockText:
					om.Content += b.Text
				case BlockToolUse:
					tc := oaiToolCall{ID: b.ID, Type: "function"}
					tc.Function.Name = b.Name
					tc.Function.Arguments = string(b.Input)
					om.ToolCalls = append(om.ToolCalls, tc)
				case BlockThinking:
					// OpenAI 协议不回传推理内容
				}
			}
			out = append(out, om)
		case RoleUser:
			var texts []string
			for _, b := range m.Content {
				switch b.Type {
				case BlockText:
					texts = append(texts, b.Text)
				case BlockToolResult:
					content := b.Content
					if b.IsError {
						content = "[错误] " + content
					}
					out = append(out, oaiMessage{Role: "tool", ToolCallID: b.ToolUseID, Content: content})
				}
			}
			if len(texts) > 0 {
				out = append(out, oaiMessage{Role: "user", Content: strings.Join(texts, "\n")})
			}
		}
	}
	return out
}

// Stream 实现 Provider。
func (c *OpenAIClient) Stream(ctx context.Context, req Request, h *StreamHandler) (*Result, error) {
	oreq := oaiReq{
		Model:     c.model,
		Messages:  convertMessages(req.System, req.Messages),
		MaxTokens: req.MaxTokens,
		Stream:    true,
		StreamOpt: &struct {
			IncludeUsage bool `json:"include_usage"`
		}{IncludeUsage: true},
	}
	for _, t := range req.Tools {
		ot := oaiTool{Type: "function"}
		ot.Function.Name = t.Name
		ot.Function.Description = t.Description
		ot.Function.Parameters = t.InputSchema
		oreq.Tools = append(oreq.Tools, ot)
	}
	body, err := json.Marshal(oreq)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("authorization", "Bearer "+c.apiKey)
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
	return parseOAISSE(resp.Body, h)
}

type oaiChunk struct {
	Choices []struct {
		Delta struct {
			Content          string        `json:"content"`
			ReasoningContent string        `json:"reasoning_content"`
			ToolCalls        []oaiToolCall `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func parseOAISSE(r io.Reader, h *StreamHandler) (*Result, error) {
	res := &Result{StopReason: StopOther}
	var text, thinking strings.Builder
	type tcAccum struct {
		id, name string
		args     strings.Builder
	}
	toolCalls := map[int]*tcAccum{}
	tcOrder := []int{}
	finish := ""

	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var ch oaiChunk
		if err := json.Unmarshal([]byte(payload), &ch); err != nil {
			continue
		}
		if ch.Error != nil {
			return nil, fmt.Errorf("llm stream error: %s", ch.Error.Message)
		}
		if ch.Usage != nil {
			res.Usage.Merge(Usage{InputTokens: ch.Usage.PromptTokens, OutputTokens: ch.Usage.CompletionTokens})
		}
		if len(ch.Choices) == 0 {
			continue
		}
		choice := ch.Choices[0]
		if choice.FinishReason != "" {
			finish = choice.FinishReason
		}
		d := choice.Delta
		if d.ReasoningContent != "" {
			thinking.WriteString(d.ReasoningContent)
			h.thinking(d.ReasoningContent)
		}
		if d.Content != "" {
			text.WriteString(d.Content)
			h.text(d.Content)
		}
		for _, tc := range d.ToolCalls {
			idx := 0
			if tc.Index != nil {
				idx = *tc.Index
			}
			acc, ok := toolCalls[idx]
			if !ok {
				acc = &tcAccum{}
				toolCalls[idx] = acc
				tcOrder = append(tcOrder, idx)
			}
			if tc.ID != "" {
				acc.id = tc.ID
			}
			if tc.Function.Name != "" {
				acc.name = tc.Function.Name
				h.toolUse(acc.id, acc.name)
			}
			acc.args.WriteString(tc.Function.Arguments)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read stream: %w", err)
	}

	msg := Message{Role: RoleAssistant}
	if thinking.Len() > 0 {
		msg.Content = append(msg.Content, ContentBlock{Type: BlockThinking, Thinking: thinking.String()})
	}
	if text.Len() > 0 {
		msg.Content = append(msg.Content, ContentBlock{Type: BlockText, Text: text.String()})
	}
	for i, idx := range tcOrder {
		acc := toolCalls[idx]
		id := acc.id
		if id == "" {
			id = fmt.Sprintf("call_%d", i)
		}
		msg.Content = append(msg.Content, ContentBlock{
			Type: BlockToolUse, ID: id, Name: acc.name,
			Input: NormalizeToolInput(acc.args.String()),
		})
	}
	if len(msg.Content) == 0 {
		return nil, fmt.Errorf("llm stream ended without any content")
	}
	res.Message = msg
	switch finish {
	case "stop":
		res.StopReason = StopEndTurn
	case "tool_calls":
		res.StopReason = StopToolUse
	case "length":
		res.StopReason = StopMaxTokens
	}
	if len(tcOrder) > 0 {
		res.StopReason = StopToolUse
	}
	return res, nil
}
