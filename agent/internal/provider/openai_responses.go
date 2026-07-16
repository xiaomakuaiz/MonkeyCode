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

// OpenAIResponsesClient OpenAI Responses 协议客户端(/responses)。
// 内部统一使用 Anthropic 风格的 Message/ContentBlock 模型,请求时转换;
// 网关的前缀缓存对 Responses 形态通常更友好。
type OpenAIResponsesClient struct {
	baseURL string
	apiKey  string
	model   string
	extra   map[string]string // 附加请求头(网关缓存亲和等)
	http    *http.Client
}

// SetExtraHeaders 设置附加请求头(每次请求都携带)。
func (c *OpenAIResponsesClient) SetExtraHeaders(h map[string]string) { c.extra = h }

// NewOpenAIResponses 创建客户端。baseURL 形如 https://host/v1(不带 /responses)。
// insecureTLS 跳过证书校验(仅自签名内网网关)。
func NewOpenAIResponses(baseURL, apiKey, model string, insecureTLS bool) *OpenAIResponsesClient {
	return &OpenAIResponsesClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		model:   model,
		http:    newHTTPClient(insecureTLS),
	}
}

func (c *OpenAIResponsesClient) Model() string { return c.model }

// respContent message 项内的内容块。
type respContent struct {
	Type string `json:"type"`           // input_text | output_text | input_image
	Text string `json:"text,omitempty"` // input_text / output_text
	// input_image(data URL)
	ImageURL string `json:"image_url,omitempty"`
}

// respItem Responses input/output 的一项。
type respItem struct {
	Type    string        `json:"type"` // message | function_call | function_call_output
	Role    string        `json:"role,omitempty"`
	Content []respContent `json:"content,omitempty"`
	// function_call
	CallID    string `json:"call_id,omitempty"`
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
	// function_call_output
	Output string `json:"output,omitempty"`
}

// respTool Responses 的工具定义(扁平结构,无嵌套 function 对象)。
type respTool struct {
	Type        string         `json:"type"`
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters"`
}

type respReq struct {
	Model           string     `json:"model"`
	Instructions    string     `json:"instructions,omitempty"`
	Input           []respItem `json:"input"`
	Tools           []respTool `json:"tools,omitempty"`
	MaxOutputTokens int        `json:"max_output_tokens,omitempty"`
	Stream          bool       `json:"stream"`
	Store           bool       `json:"store"`
}

// convertResponsesInput 把内部消息模型转为 Responses input 序列。
func convertResponsesInput(msgs []Message) []respItem {
	var out []respItem
	for _, m := range msgs {
		switch m.Role {
		case RoleAssistant:
			var texts []string
			for _, b := range m.Content {
				switch b.Type {
				case BlockText:
					texts = append(texts, b.Text)
				case BlockToolUse:
					// 文本先于工具调用落位,保持事件顺序
					if len(texts) > 0 {
						out = append(out, assistantMessage(strings.Join(texts, "\n")))
						texts = nil
					}
					out = append(out, respItem{
						Type: "function_call", CallID: b.ID, Name: b.Name, Arguments: string(b.Input),
					})
				case BlockThinking:
					// 推理内容不回传
				}
			}
			if len(texts) > 0 {
				out = append(out, assistantMessage(strings.Join(texts, "\n")))
			}
		case RoleUser:
			var texts []string
			var images []*ImageSource
			for _, b := range m.Content {
				switch b.Type {
				case BlockText:
					texts = append(texts, b.Text)
				case BlockImage:
					if b.Source != nil {
						images = append(images, b.Source)
					}
				case BlockToolResult:
					content, imgs := flattenToolResult(b)
					if b.IsError {
						content = "[错误] " + content
					}
					out = append(out, respItem{Type: "function_call_output", CallID: b.ToolUseID, Output: content})
					// Responses 的 function_call_output 只收字符串:图片经合成
					// user 消息补发,模型实际可见(对齐 Anthropic 行为)
					if len(imgs) > 0 {
						content := []respContent{{Type: "input_text", Text: "以下是上一条工具结果中的图片:"}}
						for _, src := range imgs {
							content = append(content, respContent{
								Type: "input_image", ImageURL: "data:" + src.MediaType + ";base64," + src.Data,
							})
						}
						out = append(out, respItem{Type: "message", Role: "user", Content: content})
					}
				}
			}
			if len(texts) > 0 || len(images) > 0 {
				content := []respContent{}
				if len(texts) > 0 {
					content = append(content, respContent{Type: "input_text", Text: strings.Join(texts, "\n")})
				}
				for _, src := range images {
					content = append(content, respContent{
						Type: "input_image", ImageURL: "data:" + src.MediaType + ";base64," + src.Data,
					})
				}
				out = append(out, respItem{Type: "message", Role: "user", Content: content})
			}
		}
	}
	return out
}

func assistantMessage(text string) respItem {
	return respItem{
		Type: "message", Role: "assistant",
		Content: []respContent{{Type: "output_text", Text: text}},
	}
}

// Stream 实现 Provider。
func (c *OpenAIResponsesClient) Stream(ctx context.Context, req Request, h *StreamHandler) (*Result, error) {
	rreq := respReq{
		Model:           c.model,
		Instructions:    req.System,
		Input:           convertResponsesInput(req.Messages),
		MaxOutputTokens: req.MaxTokens,
		Stream:          true,
		Store:           false, // 不在服务端留存,历史由内核自管
	}
	for _, t := range req.Tools {
		rreq.Tools = append(rreq.Tools, respTool{
			Type: "function", Name: t.Name, Description: t.Description, Parameters: t.InputSchema,
		})
	}
	body, err := json.Marshal(rreq)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/responses", bytes.NewReader(body))
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
	return parseResponsesSSE(resp.Body, h)
}

// respEvent 流式事件(data 里的 type 区分,浅解析压缩所需字段)。
type respEvent struct {
	Type  string `json:"type"`
	Delta string `json:"delta"`
	Item  *struct {
		Type      string `json:"type"`
		CallID    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"item"`
	OutputIndex int `json:"output_index"`
	Response    *struct {
		Status string `json:"status"`
		Usage  *struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
		IncompleteDetails *struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	} `json:"response"`
	Message string `json:"message"` // type=error
}

func parseResponsesSSE(r io.Reader, h *StreamHandler) (*Result, error) {
	res := &Result{StopReason: StopOther}
	var text, thinking strings.Builder
	type fcAccum struct {
		callID, name string
		args         strings.Builder
		final        string // output_item.done 给出的完整 arguments,优先使用
	}
	calls := map[int]*fcAccum{}
	var order []int
	status := ""
	incompleteReason := ""

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
		var ev respEvent
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			continue
		}
		switch ev.Type {
		case "response.output_text.delta":
			text.WriteString(ev.Delta)
			h.text(ev.Delta)
		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			thinking.WriteString(ev.Delta)
			h.thinking(ev.Delta)
		case "response.output_item.added":
			if ev.Item != nil && ev.Item.Type == "function_call" {
				acc := &fcAccum{callID: ev.Item.CallID, name: ev.Item.Name}
				acc.args.WriteString(ev.Item.Arguments)
				calls[ev.OutputIndex] = acc
				order = append(order, ev.OutputIndex)
				h.toolUse(acc.callID, acc.name)
			}
		case "response.function_call_arguments.delta":
			if acc, ok := calls[ev.OutputIndex]; ok {
				acc.args.WriteString(ev.Delta)
			}
		case "response.output_item.done":
			if ev.Item != nil && ev.Item.Type == "function_call" {
				if acc, ok := calls[ev.OutputIndex]; ok {
					if ev.Item.Arguments != "" {
						acc.final = ev.Item.Arguments
					}
					if acc.callID == "" {
						acc.callID = ev.Item.CallID
					}
					if acc.name == "" {
						acc.name = ev.Item.Name
					}
				}
			}
		case "response.completed", "response.incomplete", "response.failed":
			if ev.Response != nil {
				status = ev.Response.Status
				if ev.Response.Usage != nil {
					res.Usage.Merge(Usage{
						InputTokens:  ev.Response.Usage.InputTokens,
						OutputTokens: ev.Response.Usage.OutputTokens,
					})
				}
				if ev.Response.IncompleteDetails != nil {
					incompleteReason = ev.Response.IncompleteDetails.Reason
				}
				if ev.Response.Error != nil {
					return nil, fmt.Errorf("llm stream error: %s", ev.Response.Error.Message)
				}
			}
		case "error":
			return nil, fmt.Errorf("llm stream error: %s", ev.Message)
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
	for i, idx := range order {
		acc := calls[idx]
		args := acc.final
		if args == "" {
			args = acc.args.String()
		}
		id := acc.callID
		if id == "" {
			id = fmt.Sprintf("call_%d", i)
		}
		msg.Content = append(msg.Content, ContentBlock{
			Type: BlockToolUse, ID: id, Name: acc.name,
			Input: NormalizeToolInput(args),
		})
	}
	if len(msg.Content) == 0 {
		return nil, fmt.Errorf("llm stream ended without any content")
	}
	res.Message = msg

	switch {
	case len(order) > 0:
		res.StopReason = StopToolUse
	case status == "completed":
		res.StopReason = StopEndTurn
	case status == "incomplete" && incompleteReason == "max_output_tokens":
		res.StopReason = StopMaxTokens
	}
	return res, nil
}
