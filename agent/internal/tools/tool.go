// Package tools 内核内置工具集与注册表。
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/chaitin/MonkeyCode/agent/internal/provider"
)

// Env 工具执行环境。
type Env struct {
	Workdir string // 工作区根目录(绝对路径),文件类工具的强制边界
}

// Tool 工具接口。
type Tool interface {
	Name() string
	Description() string
	InputSchema() map[string]any
	// Title 由入参生成用于 UI 展示的一行标题,如 "读取 main.go"。
	Title(input json.RawMessage) string
	// Execute 执行并返回给模型的文本结果。
	Execute(ctx context.Context, env *Env, input json.RawMessage) (string, error)
}

// Registry 工具注册表。
type Registry struct {
	tools map[string]Tool
}

// NewRegistry 创建注册表并注册内置工具。
func NewRegistry() *Registry {
	r := &Registry{tools: map[string]Tool{}}
	for _, t := range []Tool{
		&ReadFile{}, &WriteFile{}, &EditFile{}, &Bash{}, &Grep{}, &Glob{}, &Git{}, &Todo{},
	} {
		r.Register(t)
	}
	return r
}

// Register 注册工具。
func (r *Registry) Register(t Tool) { r.tools[t.Name()] = t }

// Get 按名取工具。
func (r *Registry) Get(name string) (Tool, bool) {
	t, ok := r.tools[name]
	return t, ok
}

// Close 释放持有跨调用状态的工具资源(如 bash 的 env 快照文件)。
func (r *Registry) Close() {
	for _, t := range r.tools {
		if c, ok := t.(interface{ Close() }); ok {
			c.Close()
		}
	}
}

// Defs 导出为 LLM 工具定义(名称有序,保证请求可复现)。
func (r *Registry) Defs() []provider.ToolDef {
	names := make([]string, 0, len(r.tools))
	for n := range r.tools {
		names = append(names, n)
	}
	sort.Strings(names)
	defs := make([]provider.ToolDef, 0, len(names))
	for _, n := range names {
		t := r.tools[n]
		defs = append(defs, provider.ToolDef{
			Name:        t.Name(),
			Description: t.Description(),
			InputSchema: t.InputSchema(),
		})
	}
	return defs
}

// ==================== 公共辅助 ====================

// ResolveInWorkspace 解析相对/绝对路径并强制其位于工作区内。
func ResolveInWorkspace(env *Env, path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("path 不能为空")
	}
	p := path
	if !filepath.IsAbs(p) {
		p = filepath.Join(env.Workdir, p)
	}
	p = filepath.Clean(p)
	rel, err := filepath.Rel(env.Workdir, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("路径 %s 超出工作区 %s,已拒绝", path, env.Workdir)
	}
	return p, nil
}

func unmarshalInput(input json.RawMessage, v any) error {
	dec := json.NewDecoder(strings.NewReader(string(input)))
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("工具参数 JSON 解析失败: %v;原始参数: %s。请修正参数后重试", err, truncateStr(string(input), 300))
	}
	return nil
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// truncateOutput 限制返回给模型的输出长度(按字节,保留头尾)。
func truncateOutput(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	head := maxBytes * 2 / 3
	tail := maxBytes / 3
	return s[:head] + fmt.Sprintf("\n\n...[输出过长,已截断 %d 字节]...\n\n", len(s)-head-tail) + s[len(s)-tail:]
}

// 常见的无需遍历的目录。
var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true,
	"build": true, ".next": true, ".venv": true, "__pycache__": true,
	".idea": true, ".vscode": true, "target": true,
}
