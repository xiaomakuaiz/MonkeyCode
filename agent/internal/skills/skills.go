// Package skills 本地技能发现与装配。
//
// 技能 = 一个含 SKILL.md 的目录,来源两级:
//   - 项目:<工作区>/.mc-agent/skills/<name>/
//   - 全局:<配置目录>/skills/<name>/(即 ~/.config/mc-agent/skills/)
//
// 同名项目优先。SKILL.md 支持可选 YAML frontmatter(name/description),
// 缺省用目录名与正文首段。发现的技能与平台下发技能(internal/platform)
// 走同一注入通道(contextmgr.Extras + 只读根)。
package skills

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/chaitin/MonkeyCode/agent/internal/config"
	"github.com/chaitin/MonkeyCode/agent/internal/contextmgr"
)

const descMaxRunes = 120

// Skill 一个已发现的本地技能。
type Skill struct {
	Name        string
	Description string
	Dir         string // 技能目录(绝对路径)
	Doc         string // SKILL.md 绝对路径
	Source      string // "project" | "global"
}

// GlobalDir 全局技能目录(跟随配置文件所在目录,便于测试用 MC_AGENT_CONFIG 重定向)。
func GlobalDir() string {
	return filepath.Join(filepath.Dir(config.Path()), "skills")
}

// projectDir 项目技能目录。
func projectDir(workdir string) string {
	return filepath.Join(workdir, ".mc-agent", "skills")
}

// Discover 发现本地技能:项目 + 全局,同名项目优先,按名称排序稳定输出。
func Discover(workdir string) []Skill {
	seen := map[string]bool{}
	var out []Skill
	for _, base := range []struct {
		dir    string
		source string
	}{
		{projectDir(workdir), "project"},
		{GlobalDir(), "global"},
	} {
		for _, s := range scanDir(base.dir, base.source) {
			if seen[s.Name] {
				continue
			}
			seen[s.Name] = true
			out = append(out, s)
		}
	}
	return out
}

// Assemble 合并本地技能与平台下发资源,产出系统提示增量与工具只读附加根。
// platform 可为 nil;平台技能与本地同名时本地优先。
func Assemble(workdir string, platform *contextmgr.Extras, platformRoots []string) (*contextmgr.Extras, []string) {
	local := Discover(workdir)

	extras := &contextmgr.Extras{}
	var roots []string
	if platform != nil {
		extras.Rules = platform.Rules
	}

	seen := map[string]bool{}
	globalUsed := false
	for _, s := range local {
		seen[s.Name] = true
		extras.Skills = append(extras.Skills, contextmgr.PlatformSkill{
			Name: s.Name, Description: s.Description, Doc: s.Doc, Dir: s.Dir,
		})
		if s.Source == "global" {
			globalUsed = true
		}
	}
	if globalUsed {
		// 全局技能在工作区外,read_file 需要只读放行;项目技能本就在工作区内
		roots = append(roots, GlobalDir())
	}
	if platform != nil {
		for _, s := range platform.Skills {
			if seen[s.Name] {
				continue
			}
			extras.Skills = append(extras.Skills, s)
		}
		roots = append(roots, platformRoots...)
	}

	if len(extras.Rules) == 0 && len(extras.Skills) == 0 {
		return nil, nil
	}
	return extras, roots
}

// scanDir 扫描一个技能根目录,返回按目录名排序的技能列表(ReadDir 已排序)。
func scanDir(dir, source string) []Skill {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Skill
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		skillDir := filepath.Join(dir, e.Name())
		doc := findDoc(skillDir)
		if doc == "" {
			continue
		}
		name, desc := parseDoc(doc)
		if name == "" {
			name = e.Name()
		}
		out = append(out, Skill{
			Name:        name,
			Description: desc,
			Dir:         skillDir,
			Doc:         doc,
			Source:      source,
		})
	}
	return out
}

func findDoc(dir string) string {
	for _, name := range []string{"SKILL.md", "skill.md"} {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

// parseDoc 解析 SKILL.md:可选 frontmatter 的 name/description;
// description 缺省取正文第一个非标题非空行。
func parseDoc(path string) (name, desc string) {
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	inFrontmatter := false
	firstLine := true
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), " \t")
		if firstLine {
			firstLine = false
			if line == "---" {
				inFrontmatter = true
				continue
			}
		}
		if inFrontmatter {
			if line == "---" {
				inFrontmatter = false
				continue
			}
			key, val, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			val = strings.TrimSpace(val)
			switch strings.TrimSpace(key) {
			case "name":
				name = val
			case "description":
				desc = val
			}
			continue
		}
		if desc != "" {
			break
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		desc = truncateRunes(trimmed, descMaxRunes)
		break
	}
	return name, desc
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}

// Format 供 `mc-agent skills` 输出一行描述。
func (s Skill) Format() string {
	return fmt.Sprintf("%-24s [%s]  %s\n    %s", s.Name, s.Source, s.Description, s.Doc)
}
