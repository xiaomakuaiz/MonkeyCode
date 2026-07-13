package tools

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

const grepMaxResults = 200

// Grep 内容搜索。优先使用系统 ripgrep,缺失时回退到内置 Go 实现。
type Grep struct{}

type grepInput struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
	Include string `json:"include"`
}

func (t *Grep) Name() string { return "grep" }

func (t *Grep) Description() string {
	return "在工作区内按正则表达式搜索文件内容,返回 文件:行号:内容。include 可按 glob 过滤文件名(如 *.go)。"
}

func (t *Grep) InputSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"pattern": map[string]any{"type": "string", "description": "正则表达式"},
			"path":    map[string]any{"type": "string", "description": "搜索目录(默认工作区根)"},
			"include": map[string]any{"type": "string", "description": "文件名 glob 过滤,如 *.go、*.ts"},
		},
		"required": []string{"pattern"},
	}
}

func (t *Grep) Title(input json.RawMessage) string {
	var in grepInput
	_ = json.Unmarshal(input, &in)
	return "搜索 " + truncateStr(in.Pattern, 60)
}

func (t *Grep) Execute(ctx context.Context, env *Env, input json.RawMessage) (string, error) {
	var in grepInput
	if err := unmarshalInput(input, &in); err != nil {
		return "", err
	}
	if in.Pattern == "" {
		return "", fmt.Errorf("pattern 不能为空")
	}
	dir := env.Workdir
	if in.Path != "" {
		var err error
		dir, err = ResolveInWorkspace(env, in.Path)
		if err != nil {
			return "", err
		}
	}

	if rg, err := exec.LookPath("rg"); err == nil {
		return t.execRipgrep(ctx, rg, dir, env.Workdir, in)
	}
	return t.execFallback(ctx, dir, env.Workdir, in)
}

func (t *Grep) execRipgrep(ctx context.Context, rg, dir, workdir string, in grepInput) (string, error) {
	args := []string{"-n", "--no-heading", "--color", "never", "--max-count", "20", "-e", in.Pattern}
	if in.Include != "" {
		args = append(args, "--glob", in.Include)
	}
	args = append(args, ".")
	cmd := exec.CommandContext(ctx, rg, args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
			return "没有找到匹配", nil
		}
		return "", fmt.Errorf("ripgrep 执行失败: %w", err)
	}
	return formatGrepOutput(string(out), dir, workdir), nil
}

func (t *Grep) execFallback(ctx context.Context, dir, workdir string, in grepInput) (string, error) {
	re, err := regexp.Compile(in.Pattern)
	if err != nil {
		return "", fmt.Errorf("正则表达式无效: %v", err)
	}
	var b strings.Builder
	count := 0
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if count >= grepMaxResults {
			return filepath.SkipAll
		}
		if in.Include != "" {
			if ok, _ := filepath.Match(in.Include, d.Name()); !ok {
				return nil
			}
		}
		if info, err := d.Info(); err != nil || info.Size() > 2*1024*1024 {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer f.Close()
		rel, _ := filepath.Rel(workdir, path)
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		lineNo := 0
		fileMatches := 0
		for scanner.Scan() {
			lineNo++
			line := scanner.Text()
			if !utf8.ValidString(line) {
				return nil // 跳过二进制文件
			}
			if re.MatchString(line) {
				fmt.Fprintf(&b, "%s:%d:%s\n", rel, lineNo, truncateStr(line, 300))
				count++
				fileMatches++
				if fileMatches >= 20 || count >= grepMaxResults {
					return nil
				}
			}
		}
		return nil
	})
	if err != nil && err != filepath.SkipAll {
		return "", err
	}
	if count == 0 {
		return "没有找到匹配", nil
	}
	out := b.String()
	if count >= grepMaxResults {
		out += fmt.Sprintf("\n[结果过多,已截断为前 %d 条,请缩小搜索范围]", grepMaxResults)
	}
	return out, nil
}

func formatGrepOutput(out, dir, workdir string) string {
	if strings.TrimSpace(out) == "" {
		return "没有找到匹配"
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) > grepMaxResults {
		lines = append(lines[:grepMaxResults],
			fmt.Sprintf("[结果过多,已截断为前 %d 条,请缩小搜索范围]", grepMaxResults))
	}
	// rg 在 dir 下输出相对路径;统一转成相对工作区的路径
	prefix, _ := filepath.Rel(workdir, dir)
	if prefix != "" && prefix != "." {
		for i, l := range lines {
			lines[i] = prefix + string(filepath.Separator) + strings.TrimPrefix(l, "./")
		}
	}
	return truncateOutput(strings.Join(lines, "\n"), 48*1024)
}
