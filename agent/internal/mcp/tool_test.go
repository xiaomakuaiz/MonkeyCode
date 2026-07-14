package mcp

import (
	"regexp"
	"testing"
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
