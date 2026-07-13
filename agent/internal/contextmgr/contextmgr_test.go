package contextmgr

import (
	"strings"
	"testing"
)

func TestBuildWithoutExtras(t *testing.T) {
	out := Build(t.TempDir(), nil)
	if !strings.Contains(out, "# 环境") {
		t.Fatal("missing env section")
	}
	if strings.Contains(out, "# 平台规则") || strings.Contains(out, "# 平台技能") {
		t.Fatal("platform sections should be absent without extras")
	}
}

func TestBuildWithExtras(t *testing.T) {
	extras := &Extras{
		Rules: []PlatformRule{{Name: "team-style", Content: "所有导出函数必须有注释"}},
		Skills: []PlatformSkill{
			{Name: "deploy", Description: "部署技能", Doc: "/cache/skills/deploy@v1/SKILL.md", Dir: "/cache/skills/deploy@v1"},
			{Name: "no-doc", Description: "无文档技能", Dir: "/cache/skills/no-doc@v1"},
		},
	}
	out := Build(t.TempDir(), extras)

	if !strings.Contains(out, "# 平台规则") || !strings.Contains(out, "## team-style") ||
		!strings.Contains(out, "所有导出函数必须有注释") {
		t.Fatalf("platform rules not injected:\n%s", out)
	}
	if !strings.Contains(out, "# 平台技能") ||
		!strings.Contains(out, "deploy: 部署技能(文档: /cache/skills/deploy@v1/SKILL.md)") {
		t.Fatalf("platform skills not injected:\n%s", out)
	}
	// 无入口文档时退回目录路径
	if !strings.Contains(out, "no-doc: 无文档技能(文档: /cache/skills/no-doc@v1)") {
		t.Fatalf("doc fallback missing:\n%s", out)
	}
}

func TestBuildTruncatesOversizedPlatformRules(t *testing.T) {
	extras := &Extras{Rules: []PlatformRule{
		{Name: "huge", Content: strings.Repeat("规", rulesMaxBytes)},
		{Name: "after", Content: "不应完整出现"},
	}}
	out := Build(t.TempDir(), extras)
	if !strings.Contains(out, "...[平台规则过长已截断]") {
		t.Fatal("oversized rules not truncated")
	}
	if strings.Contains(out, "## after") {
		t.Fatal("rules after budget should be dropped")
	}
}
