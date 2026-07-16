package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/chaitin/MonkeyCode/agent/internal/provider"
)

const (
	readMaxBytes   = 256 * 1024
	readMaxLines   = 2000
	readMaxLineLen = 2000
)

// ReadFile 读取文件(带行号,支持分页)。
type ReadFile struct{}

type readFileInput struct {
	Path   string `json:"path"`
	Offset int    `json:"offset"`
	Limit  int    `json:"limit"`
}

func (t *ReadFile) Name() string { return "read_file" }

func (t *ReadFile) Description() string {
	return "读取工作区内的文件内容,输出带行号。大文件可用 offset/limit 分页读取。" +
		"也支持读取图片文件(png/jpg/gif/webp),将返回图片内容供查看。"
}

func (t *ReadFile) InputSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path":   map[string]any{"type": "string", "description": "文件路径(相对工作区或绝对路径)"},
			"offset": map[string]any{"type": "integer", "description": "起始行号(1 起,默认 1)"},
			"limit":  map[string]any{"type": "integer", "description": "最多读取行数(默认 2000)"},
		},
		"required": []string{"path"},
	}
}

func (t *ReadFile) Title(input json.RawMessage) string {
	var in readFileInput
	_ = json.Unmarshal(input, &in)
	return "读取 " + in.Path
}

// ExecuteBlocks 实现 BlocksTool:图片文件返回图片块,其余走文本路径。
func (t *ReadFile) ExecuteBlocks(ctx context.Context, env *Env, input json.RawMessage) ([]provider.ContentBlock, string, error) {
	var in readFileInput
	if err := unmarshalInput(input, &in); err != nil {
		return nil, "", err
	}
	if IsImagePath(in.Path) {
		p, err := ResolveForRead(env, in.Path)
		if err != nil {
			return nil, "", err
		}
		if st, serr := os.Stat(p); serr != nil || st.IsDir() {
			// 不存在/是目录等按文本路径的报错口径处理
		} else {
			return ReadImageBlocks(p, in.Path)
		}
	}
	out, err := t.Execute(ctx, env, input)
	if err != nil {
		return nil, "", err
	}
	return []provider.ContentBlock{{Type: provider.BlockText, Text: out}}, out, nil
}

func (t *ReadFile) Execute(_ context.Context, env *Env, input json.RawMessage) (string, error) {
	var in readFileInput
	if err := unmarshalInput(input, &in); err != nil {
		return "", err
	}
	p, err := ResolveForRead(env, in.Path)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(p)
	if err != nil {
		return "", fmt.Errorf("无法读取 %s: %w", in.Path, err)
	}
	if st.IsDir() {
		entries, err := os.ReadDir(p)
		if err != nil {
			return "", err
		}
		var b strings.Builder
		fmt.Fprintf(&b, "%s 是目录,包含 %d 项:\n", in.Path, len(entries))
		for _, e := range entries {
			suffix := ""
			if e.IsDir() {
				suffix = "/"
			}
			b.WriteString(e.Name())
			b.WriteString(suffix)
			b.WriteString("\n")
		}
		return b.String(), nil
	}

	data, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	if len(data) > 4*1024*1024 {
		return "", fmt.Errorf("文件 %s 过大(%d 字节),请用 grep 或 offset/limit 定位后再读", in.Path, len(data))
	}

	lines := strings.Split(string(data), "\n")
	offset := in.Offset
	if offset < 1 {
		offset = 1
	}
	limit := in.Limit
	if limit <= 0 || limit > readMaxLines {
		limit = readMaxLines
	}
	if offset > len(lines) {
		return "", fmt.Errorf("offset %d 超出文件总行数 %d", offset, len(lines))
	}

	end := min(offset-1+limit, len(lines))
	var b strings.Builder
	for i := offset - 1; i < end; i++ {
		line := lines[i]
		if len(line) > readMaxLineLen {
			line = line[:readMaxLineLen] + "...[行过长截断]"
		}
		fmt.Fprintf(&b, "%6d\t%s\n", i+1, line)
	}
	out := b.String()
	if end < len(lines) {
		out += fmt.Sprintf("\n[文件共 %d 行,已显示 %d-%d 行,继续读取请用 offset=%d]", len(lines), offset, end, end+1)
	}
	return truncateOutput(out, readMaxBytes), nil
}
