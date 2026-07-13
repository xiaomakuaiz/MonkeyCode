// Package contextmgr 负责装配系统提示:基础提示 + 环境信息 + 项目规则 + 仓库结构摘要。
package contextmgr

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	rulesMaxBytes = 32 * 1024
	treeMaxFiles  = 200
	treeMaxDepth  = 3
)

// 项目规则文件,按优先级取第一个存在的。
var ruleFiles = []string{"AGENTS.md", "CLAUDE.md", ".mc-agent/rules.md"}

const basePrompt = `你是 MonkeyCode 本地编码 agent,直接在用户的机器上通过工具完成软件工程任务。

# 工作方式
- 先理解再动手:改代码前用 read_file/grep/glob 了解相关实现与项目惯例。
- 复杂任务先用 todo 工具列出计划,每完成一步更新状态;简单任务不必列计划。
- 修改已有文件优先用 edit_file(精确替换);只有新建或整体重写时才用 write_file。
- 做完改动要验证:能构建的项目跑构建,有测试的跑相关测试,并如实报告结果。
- 编辑代码后保持格式:Go 项目对改过的文件执行 gofmt -w,其他语言用项目已有的格式化工具。
- 遵循项目现有的代码风格、命名与注释密度,不做超出任务范围的改动。

# 约束
- 所有文件操作限定在工作区内;不要执行交互式命令(如 vim、git rebase -i)。
- 不要主动 git commit/push,除非用户明确要求。
- 不确定的需求按最合理的理解执行并在最后说明,不要中途停下来反问。
- 最终回复使用与用户一致的语言,简洁说明做了什么、改了哪些文件、验证结果如何。`

// Build 组装完整系统提示。
func Build(workdir string) string {
	var b strings.Builder
	b.WriteString(basePrompt)
	b.WriteString("\n\n# 环境\n")
	fmt.Fprintf(&b, "- 操作系统: %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Fprintf(&b, "- 工作区: %s\n", workdir)
	fmt.Fprintf(&b, "- 日期: %s\n", time.Now().Format("2006-01-02"))
	if branch := gitBranch(workdir); branch != "" {
		fmt.Fprintf(&b, "- git 分支: %s\n", branch)
	}

	if rules := loadRules(workdir); rules != "" {
		b.WriteString("\n# 项目规则(来自项目配置文件,必须遵守)\n")
		b.WriteString(rules)
		b.WriteString("\n")
	}

	if tree := repoTree(workdir); tree != "" {
		b.WriteString("\n# 仓库结构摘要\n")
		b.WriteString(tree)
	}
	return b.String()
}

func gitBranch(workdir string) string {
	cmd := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD")
	cmd.Dir = workdir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func loadRules(workdir string) string {
	for _, name := range ruleFiles {
		p := filepath.Join(workdir, name)
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		s := string(data)
		if len(s) > rulesMaxBytes {
			s = s[:rulesMaxBytes] + "\n...[规则文件过长已截断]"
		}
		return fmt.Sprintf("(%s)\n%s", name, s)
	}
	return ""
}

var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true,
	"build": true, ".next": true, ".venv": true, "__pycache__": true,
	".idea": true, ".vscode": true, "target": true,
}

// repoTree 生成有限深度/数量的目录树摘要。
func repoTree(workdir string) string {
	type entry struct {
		rel   string
		isDir bool
	}
	var entries []entry
	count := 0
	_ = filepath.WalkDir(workdir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if path == workdir {
			return nil
		}
		rel, _ := filepath.Rel(workdir, path)
		depth := strings.Count(rel, string(filepath.Separator)) + 1
		if d.IsDir() {
			if skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			if depth >= treeMaxDepth {
				entries = append(entries, entry{rel + "/...", true})
				return filepath.SkipDir
			}
			entries = append(entries, entry{rel + "/", true})
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		count++
		if count > treeMaxFiles {
			return filepath.SkipAll
		}
		entries = append(entries, entry{rel, false})
		return nil
	})
	if len(entries) == 0 {
		return ""
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].rel < entries[j].rel })
	var b strings.Builder
	for _, e := range entries {
		b.WriteString(filepath.ToSlash(e.rel))
		b.WriteString("\n")
	}
	if count > treeMaxFiles {
		fmt.Fprintf(&b, "...[仅显示前 %d 个文件,完整结构请用 glob/grep 探索]\n", treeMaxFiles)
	}
	return b.String()
}
