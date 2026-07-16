package provider

import (
	"encoding/json"
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
