package skills

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/chaitin/MonkeyCode/agent/internal/contextmgr"
)

// withGlobalDir 把全局技能目录重定向到临时目录(经 MC_AGENT_CONFIG)。
func withGlobalDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("MC_AGENT_CONFIG", filepath.Join(dir, "config.json"))
	return filepath.Join(dir, "skills")
}

func writeSkill(t *testing.T, base, name, doc string) string {
	t.Helper()
	dir := filepath.Join(base, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestDiscoverAndParse(t *testing.T) {
	globalDir := withGlobalDir(t)
	workdir := t.TempDir()
	projDir := filepath.Join(workdir, ".mc-agent", "skills")

	// frontmatter 完整
	writeSkill(t, projDir, "deploy", "---\nname: deploy-pro\ndescription: 部署到测试环境\n---\n# Deploy\n正文")
	// 无 frontmatter:名称取目录名,描述取正文首个非标题行
	writeSkill(t, projDir, "review", "# Review\n\n代码评审检查单。\n细节...")
	// 全局技能
	writeSkill(t, globalDir, "notes", "---\ndescription: 全局笔记技能\n---\n# notes")
	// 同名:项目优先
	writeSkill(t, globalDir, "review", "---\ndescription: 全局版本,应被项目覆盖\n---\n")
	// 无 SKILL.md 的目录忽略
	if err := os.MkdirAll(filepath.Join(projDir, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := Discover(workdir)
	byName := map[string]Skill{}
	for _, s := range got {
		byName[s.Name] = s
	}
	if len(got) != 3 {
		t.Fatalf("want 3 skills, got %d: %+v", len(got), got)
	}
	if s := byName["deploy-pro"]; s.Description != "部署到测试环境" || s.Source != "project" {
		t.Fatalf("deploy-pro: %+v", s)
	}
	if s := byName["review"]; s.Source != "project" || s.Description != "代码评审检查单。" {
		t.Fatalf("review 应为项目版本: %+v", s)
	}
	if s := byName["notes"]; s.Source != "global" || s.Description != "全局笔记技能" {
		t.Fatalf("notes: %+v", s)
	}
}

func TestAssembleMergesLocalAndPlatform(t *testing.T) {
	globalDir := withGlobalDir(t)
	workdir := t.TempDir()
	writeSkill(t, filepath.Join(workdir, ".mc-agent", "skills"), "deploy", "---\ndescription: 本地部署\n---\n")
	writeSkill(t, globalDir, "notes", "---\ndescription: 全局笔记\n---\n")

	plat := &contextmgr.Extras{
		Rules: []contextmgr.PlatformRule{{Name: "r1", Content: "平台规则"}},
		Skills: []contextmgr.PlatformSkill{
			{Name: "deploy", Description: "平台部署(应被本地覆盖)", Dir: "/plat/deploy"},
			{Name: "audit", Description: "平台审计", Dir: "/plat/audit"},
		},
	}
	extras, roots := Assemble(workdir, plat, []string{"/plat/deploy", "/plat/audit"})
	if extras == nil || len(extras.Rules) != 1 {
		t.Fatalf("rules: %+v", extras)
	}
	if len(extras.Skills) != 3 {
		t.Fatalf("want 3 skills, got %+v", extras.Skills)
	}
	descs := map[string]string{}
	for _, s := range extras.Skills {
		descs[s.Name] = s.Description
	}
	if descs["deploy"] != "本地部署" {
		t.Fatalf("同名应本地优先: %q", descs["deploy"])
	}
	if descs["audit"] != "平台审计" || descs["notes"] != "全局笔记" {
		t.Fatalf("merge: %+v", descs)
	}
	// roots 含全局技能根 + 平台根
	wantRoots := map[string]bool{GlobalDir(): true, "/plat/deploy": true, "/plat/audit": true}
	if len(roots) != 3 {
		t.Fatalf("roots: %+v", roots)
	}
	for _, r := range roots {
		if !wantRoots[r] {
			t.Fatalf("unexpected root %q in %+v", r, roots)
		}
	}
}

func TestAssembleEmpty(t *testing.T) {
	withGlobalDir(t)
	if extras, roots := Assemble(t.TempDir(), nil, nil); extras != nil || roots != nil {
		t.Fatalf("空场景应返回 nil: %+v %+v", extras, roots)
	}
}

func TestAssembleLocalOnlyProjectSkillNeedsNoRoots(t *testing.T) {
	withGlobalDir(t)
	workdir := t.TempDir()
	writeSkill(t, filepath.Join(workdir, ".mc-agent", "skills"), "deploy", "---\ndescription: 本地\n---\n")
	extras, roots := Assemble(workdir, nil, nil)
	if extras == nil || len(extras.Skills) != 1 {
		t.Fatalf("extras: %+v", extras)
	}
	if len(roots) != 0 {
		t.Fatalf("项目内技能无需附加只读根: %+v", roots)
	}
}
