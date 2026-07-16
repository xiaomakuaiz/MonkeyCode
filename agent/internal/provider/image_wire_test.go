package provider

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func imageToolResultMsg() Message {
	return Message{Role: RoleUser, Content: []ContentBlock{
		{Type: BlockToolResult, ToolUseID: "t1", Blocks: []ContentBlock{
			{Type: BlockImage, Source: &ImageSource{Type: "base64", MediaType: "image/png", Data: "AAAA"}},
			{Type: BlockText, Text: "图片 a.png(10×10)"},
		}},
	}}
}

// ==================== Anthropic:tool_result 富内容转 content 块数组 ====================

func TestAnthropicWire_ImageToolResult(t *testing.T) {
	wire := toAnthropicWire([]Message{imageToolResultMsg()})
	data, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	for _, want := range []string{
		`"type":"tool_result"`, `"tool_use_id":"t1"`,
		`"type":"image"`, `"media_type":"image/png"`, `"data":"AAAA"`,
		`"type":"text"`,
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("线上载荷缺少 %s: %s", want, s)
		}
	}
	if strings.Contains(s, `"blocks"`) {
		t.Fatalf("内部 blocks 字段不应出现在线上载荷: %s", s)
	}
}

// 纯文本 tool_result 保持字符串 content(回归)
func TestAnthropicWire_PlainToolResult(t *testing.T) {
	wire := toAnthropicWire([]Message{{Role: RoleUser, Content: []ContentBlock{
		{Type: BlockToolResult, ToolUseID: "t1", Content: "ok"},
	}}})
	data, _ := json.Marshal(wire)
	if !strings.Contains(string(data), `"content":"ok"`) {
		t.Fatalf("纯文本结果应保持字符串 content: %s", data)
	}
}

// ==================== OpenAI Chat:占位文本 + 合成 user 图片消息 ====================

func TestOpenAIConvert_ImageToolResult(t *testing.T) {
	out := convertMessages("", []Message{imageToolResultMsg()})
	if len(out) != 2 {
		t.Fatalf("应产出 tool + 合成 user 两条消息,实际 %d 条: %+v", len(out), out)
	}
	if out[0].Role != "tool" || out[0].ToolCallID != "t1" {
		t.Fatalf("第一条应为 tool 消息: %+v", out[0])
	}
	toolText, _ := out[0].Content.(string)
	if !strings.Contains(toolText, "图片内容见下一条消息") {
		t.Fatalf("tool 消息应含占位说明: %q", toolText)
	}
	if out[1].Role != "user" {
		t.Fatalf("第二条应为合成 user 消息: %+v", out[1])
	}
	parts, ok := out[1].Content.([]oaiPart)
	if !ok {
		t.Fatalf("合成消息 content 应为 parts 数组: %T", out[1].Content)
	}
	var hasImage bool
	for _, p := range parts {
		if p.Type == "image_url" && p.ImageURL != nil && strings.HasPrefix(p.ImageURL.URL, "data:image/png;base64,") {
			hasImage = true
		}
	}
	if !hasImage {
		t.Fatalf("合成消息缺少 image_url 分片: %+v", parts)
	}
}

// ==================== OpenAI Responses:function_call_output + input_image ====================

func TestResponsesConvert_ImageToolResult(t *testing.T) {
	out := convertResponsesInput([]Message{imageToolResultMsg()})
	if len(out) != 2 {
		t.Fatalf("应产出 function_call_output + 合成 user 两项,实际 %d: %+v", len(out), out)
	}
	if out[0].Type != "function_call_output" || !strings.Contains(out[0].Output, "图片内容见下一条消息") {
		t.Fatalf("第一项应为带占位说明的 function_call_output: %+v", out[0])
	}
	var hasImage bool
	for _, c := range out[1].Content {
		if c.Type == "input_image" && strings.HasPrefix(c.ImageURL, "data:image/png;base64,") {
			hasImage = true
		}
	}
	if out[1].Role != "user" || !hasImage {
		t.Fatalf("第二项应为携带 input_image 的 user 消息: %+v", out[1])
	}
}

// ==================== 出站请求体完整性:base64 不截断、可解码还原 ====================

// TestAnthropicStream_ImagePayloadIntact 用真实 HTTP 服务捕获 AnthropicClient
// 实际发出的请求体,验证长 base64(>10k 字符)完整连续、可解码还原为原始
// 字节——排除"内核把图片数据截断后发送"的可能(日志查看器的展示截断
// 不代表载荷截断)。
func TestAnthropicStream_ImagePayloadIntact(t *testing.T) {
	// 约 60KB 伪图片字节(base64 后 ~80k 字符,远超常见日志截断阈值)
	raw := make([]byte, 60_000)
	for i := range raw {
		raw[i] = byte(i * 31)
	}
	b64 := base64.StdEncoding.EncodeToString(raw)

	var gotBody []byte
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		// 最小合法 SSE 流,让 Stream 正常收尾
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"))
	}))
	defer ts.Close()

	c := NewAnthropic(ts.URL, "test-key", "test-model")
	msgs := []Message{
		{Role: RoleUser, Content: []ContentBlock{{Type: BlockText, Text: "看图"}}},
		{Role: RoleAssistant, Content: []ContentBlock{{Type: BlockToolUse, ID: "t1", Name: "read_file", Input: []byte(`{}`)}}},
		{Role: RoleUser, Content: []ContentBlock{
			{Type: BlockToolResult, ToolUseID: "t1", Blocks: []ContentBlock{
				{Type: BlockImage, Source: &ImageSource{Type: "base64", MediaType: "image/png", Data: b64}},
				{Type: BlockText, Text: "图片 shot.png"},
			}},
		}},
	}
	_, _ = c.Stream(context.Background(), Request{Messages: msgs}, nil)

	if len(gotBody) == 0 {
		t.Fatal("未捕获到请求体")
	}
	// 从请求体 JSON 里取回 source.data,应与原始 base64 完全一致
	var req struct {
		Messages []struct {
			Content []struct {
				Type    BlockType `json:"type"`
				Content []struct {
					Type   BlockType    `json:"type"`
					Source *ImageSource `json:"source"`
				} `json:"content"`
			} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(gotBody, &req); err != nil {
		t.Fatalf("请求体不是合法 JSON(若 base64 中途截断会走到这): %v", err)
	}
	var got string
	for _, m := range req.Messages {
		for _, b := range m.Content {
			for _, ib := range b.Content {
				if ib.Type == BlockImage && ib.Source != nil {
					got = ib.Source.Data
				}
			}
		}
	}
	if got == "" {
		t.Fatal("请求体中未找到图片块")
	}
	if len(got) != len(b64) || got != b64 {
		t.Fatalf("base64 不完整: 发出 %d 字符,应为 %d 字符", len(got), len(b64))
	}
	back, err := base64.StdEncoding.DecodeString(got)
	if err != nil || !bytes.Equal(back, raw) {
		t.Fatal("base64 解码后与原始字节不一致")
	}
}
