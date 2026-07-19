package mcp

import (
	"bytes"
	"image"
	"image/png"
	"regexp"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/chaitin/MonkeyCode/agent/internal/provider"
)

func TestToolNameSanitize(t *testing.T) {
	valid := regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
	cases := []struct{ server, tool string }{
		{"websearch", "web_search"}, // 全合法:保持原样
		{"百智搜索", "web_search"},      // 中文 server 名
		{"my.server", "tool.name"},  // 点号
		{"联网 搜索", "查 询"},            // 中文 + 空格
		{"", ""},                    // 极端空名
		{"a b", "a-b"},
	}
	seen := map[string]bool{}
	for _, c := range cases {
		name := ToolName(c.server, c.tool)
		if !valid.MatchString(name) {
			t.Fatalf("ToolName(%q,%q)=%q 不匹配 LLM 工具名正则", c.server, c.tool, name)
		}
		if seen[name] {
			t.Fatalf("撞名: %q", name)
		}
		seen[name] = true
	}
	// 合法名零改写(既有 --allow/持久化规则不受影响)
	if got := ToolName("websearch", "web_search"); got != "mcp__websearch__web_search" {
		t.Fatalf("合法名被改写: %q", got)
	}
	// 确定性:同名多次调用结果一致
	if ToolName("百智搜索", "查询") != ToolName("百智搜索", "查询") {
		t.Fatal("净化结果不稳定")
	}
	// 不同原名(即使净化后骨架相同)不撞名
	if ToolName("搜索A", "t") == ToolName("搜索B", "t") {
		t.Fatal("不同原名净化后撞名")
	}
}

// ==================== resultToBlocks:图片透传 + 文本形状不变 ====================

func testPNGBytes(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 20, 10))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestResultToBlocks_TextOnlySingleBlock(t *testing.T) {
	res := &sdk.CallToolResult{Content: []sdk.Content{
		&sdk.TextContent{Text: "第一行"},
		&sdk.TextContent{Text: "第二行"},
	}}
	blocks, display := resultToBlocks(res)
	// 纯文本必须保持单文本块(loop 压平为普通字符串结果,历史形状不变)
	if len(blocks) != 1 || blocks[0].Type != provider.BlockText {
		t.Fatalf("纯文本应为单文本块: %+v", blocks)
	}
	if blocks[0].Text != "第一行\n第二行" {
		t.Fatalf("文本合并不对: %q", blocks[0].Text)
	}
	if display != "第一行" {
		t.Fatalf("display 应取首行: %q", display)
	}
}

func TestResultToBlocks_ImagePassthrough(t *testing.T) {
	res := &sdk.CallToolResult{Content: []sdk.Content{
		&sdk.ImageContent{Data: testPNGBytes(t), MIMEType: "image/png"},
		&sdk.TextContent{Text: "截图说明"},
	}}
	blocks, display := resultToBlocks(res)
	if len(blocks) != 2 || blocks[0].Type != provider.BlockImage || blocks[1].Type != provider.BlockText {
		t.Fatalf("应为 [image, text]: %+v", blocks)
	}
	src := blocks[0].Source
	if src == nil || src.Type != "base64" || src.MediaType != "image/png" {
		t.Fatalf("图片 source 形状不对: %+v", src)
	}
	if src.Data == "" {
		t.Fatal("图片 base64 数据为空")
	}
	if display == "" {
		t.Fatal("display 为空")
	}
}

func TestResultToBlocks_BadImageDegradesToText(t *testing.T) {
	res := &sdk.CallToolResult{Content: []sdk.Content{
		&sdk.ImageContent{Data: []byte("broken"), MIMEType: "image/png"},
	}}
	blocks, _ := resultToBlocks(res)
	if len(blocks) != 1 || blocks[0].Type != provider.BlockText {
		t.Fatalf("坏图片应降级为文本占位: %+v", blocks)
	}
	if !strings.Contains(blocks[0].Text, "图片处理失败") {
		t.Fatalf("占位文本不对: %q", blocks[0].Text)
	}
}

func TestResultToBlocks_EmptyOutput(t *testing.T) {
	blocks, _ := resultToBlocks(&sdk.CallToolResult{})
	if len(blocks) != 1 || blocks[0].Text != "(无输出)" {
		t.Fatalf("空结果应为占位单文本块: %+v", blocks)
	}
}
