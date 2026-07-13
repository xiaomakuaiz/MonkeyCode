package provider

import (
	"strings"
	"testing"
)

func TestNormalizeToolInput(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"valid", `{"a":1}`, `{"a":1}`},
		{"empty", "", "{}"},
		{"fenced", "```json\n{\"a\":1}\n```", `{"a":1}`},
		{"fence-no-lang", "```\n{\"a\":1}\n```", `{"a":1}`},
		{"trailing-comma", `{"a":1,}`, `{"a":1}`},
		{"nested-trailing", `{"a":[1,2,],}`, `{"a":[1,2]}`},
		{"prose-wrapped", `参数如下:{"path":"x.go"} 请执行`, `{"path":"x.go"}`},
		{"comma-in-string", `{"a":",}","b":1}`, `{"a":",}","b":1}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := string(NormalizeToolInput(c.in))
			if got != c.want {
				t.Fatalf("NormalizeToolInput(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestParseSSE_TextAndToolUse(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想一想"}}`,
		`data: {"type":"content_block_stop","index":0}`,
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好"}}`,
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"世界"}}`,
		`data: {"type":"content_block_stop","index":1}`,
		`data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t1","name":"read_file","input":{}}}`,
		`data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}`,
		`data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"a.go\"}"}}`,
		`data: {"type":"content_block_stop","index":2}`,
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":25}}`,
		`data: {"type":"message_stop"}`,
	}, "\n\n")

	var texts, thoughts []string
	h := &StreamHandler{
		OnText:     func(d string) { texts = append(texts, d) },
		OnThinking: func(d string) { thoughts = append(thoughts, d) },
	}
	res, err := parseSSE(strings.NewReader(stream), h)
	if err != nil {
		t.Fatal(err)
	}
	if res.StopReason != StopToolUse {
		t.Fatalf("stop reason = %s", res.StopReason)
	}
	if res.Usage.InputTokens != 10 || res.Usage.OutputTokens != 25 {
		t.Fatalf("usage = %+v", res.Usage)
	}
	if len(res.Message.Content) != 3 {
		t.Fatalf("blocks = %d", len(res.Message.Content))
	}
	if res.Message.Content[1].Text != "你好世界" {
		t.Fatalf("text = %q", res.Message.Content[1].Text)
	}
	tus := res.ToolUses()
	if len(tus) != 1 || tus[0].Name != "read_file" || string(tus[0].Input) != `{"path":"a.go"}` {
		t.Fatalf("tool use = %+v", tus)
	}
	if strings.Join(texts, "") != "你好世界" || strings.Join(thoughts, "") != "想一想" {
		t.Fatalf("callbacks: texts=%v thoughts=%v", texts, thoughts)
	}
}

func TestParseSSE_ErrorEvent(t *testing.T) {
	stream := `data: {"type":"error","error":{"type":"overloaded","message":"server busy"}}`
	_, err := parseSSE(strings.NewReader(stream), nil)
	if err == nil || !strings.Contains(err.Error(), "server busy") {
		t.Fatalf("err = %v", err)
	}
}

func TestParseOAISSE_ToolCalls(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"choices":[{"delta":{"reasoning_content":"想"}}]}`,
		`data: {"choices":[{"delta":{"content":"好的"}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"bash","arguments":"{\"comm"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\":\"ls\"}"}}]}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		`data: {"usage":{"prompt_tokens":5,"completion_tokens":9}}`,
		`data: [DONE]`,
	}, "\n\n")
	res, err := parseOAISSE(strings.NewReader(stream), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.StopReason != StopToolUse {
		t.Fatalf("stop = %s", res.StopReason)
	}
	tus := res.ToolUses()
	if len(tus) != 1 || tus[0].Name != "bash" || string(tus[0].Input) != `{"command":"ls"}` {
		t.Fatalf("tool uses = %+v", tus)
	}
	if res.Usage.InputTokens != 5 || res.Usage.OutputTokens != 9 {
		t.Fatalf("usage = %+v", res.Usage)
	}
}

func TestConvertMessages(t *testing.T) {
	msgs := []Message{
		TextMessage(RoleUser, "做点事"),
		{Role: RoleAssistant, Content: []ContentBlock{
			{Type: BlockThinking, Thinking: "内部推理"},
			{Type: BlockText, Text: "我来执行"},
			{Type: BlockToolUse, ID: "t1", Name: "bash", Input: []byte(`{"command":"ls"}`)},
		}},
		{Role: RoleUser, Content: []ContentBlock{
			{Type: BlockToolResult, ToolUseID: "t1", Content: "file.txt"},
		}},
	}
	out := convertMessages("system prompt", msgs)
	if len(out) != 4 {
		t.Fatalf("len = %d: %+v", len(out), out)
	}
	if out[0].Role != "system" || out[1].Role != "user" {
		t.Fatalf("roles: %+v", out)
	}
	if out[2].Role != "assistant" || len(out[2].ToolCalls) != 1 || out[2].Content != "我来执行" {
		t.Fatalf("assistant: %+v", out[2])
	}
	if out[3].Role != "tool" || out[3].ToolCallID != "t1" {
		t.Fatalf("tool msg: %+v", out[3])
	}
}
