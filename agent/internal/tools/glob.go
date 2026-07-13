package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
)

const globMaxResults = 300

// Glob 按 glob 模式匹配文件路径(支持 **)。
type Glob struct{}

type globInput struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
}

func (t *Glob) Name() string { return "glob" }

func (t *Glob) Description() string {
	return "按 glob 模式列出匹配的文件路径,支持 **(如 src/**/*.ts、**/*_test.go)。"
}

func (t *Glob) InputSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"pattern": map[string]any{"type": "string", "description": "glob 模式,支持 **"},
			"path":    map[string]any{"type": "string", "description": "起始目录(默认工作区根)"},
		},
		"required": []string{"pattern"},
	}
}

func (t *Glob) Title(input json.RawMessage) string {
	var in globInput
	_ = json.Unmarshal(input, &in)
	return "查找 " + in.Pattern
}

func (t *Glob) Execute(ctx context.Context, env *Env, input json.RawMessage) (string, error) {
	var in globInput
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

	var matches []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
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
		if len(matches) >= globMaxResults {
			return filepath.SkipAll
		}
		rel, _ := filepath.Rel(dir, path)
		rel = filepath.ToSlash(rel)
		if ok, _ := doublestar.Match(in.Pattern, rel); ok {
			wrel, _ := filepath.Rel(env.Workdir, path)
			matches = append(matches, filepath.ToSlash(wrel))
		}
		return nil
	})
	if err != nil && err != filepath.SkipAll {
		return "", err
	}
	if len(matches) == 0 {
		return "没有匹配的文件", nil
	}
	sort.Strings(matches)
	out := strings.Join(matches, "\n")
	if len(matches) >= globMaxResults {
		out += fmt.Sprintf("\n[结果过多,已截断为前 %d 条]", globMaxResults)
	}
	return out, nil
}
