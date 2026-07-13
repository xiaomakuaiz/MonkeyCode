package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// WriteFile 写入(创建或覆盖)文件。
type WriteFile struct{}

type writeFileInput struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (t *WriteFile) Name() string { return "write_file" }

func (t *WriteFile) Description() string {
	return "将完整内容写入工作区内的文件(不存在则创建,存在则整体覆盖)。修改已有文件优先用 edit_file。"
}

func (t *WriteFile) InputSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path":    map[string]any{"type": "string", "description": "文件路径(相对工作区或绝对路径)"},
			"content": map[string]any{"type": "string", "description": "写入的完整文件内容"},
		},
		"required": []string{"path", "content"},
	}
}

func (t *WriteFile) Title(input json.RawMessage) string {
	var in writeFileInput
	_ = json.Unmarshal(input, &in)
	return "写入 " + in.Path
}

func (t *WriteFile) Execute(_ context.Context, env *Env, input json.RawMessage) (string, error) {
	var in writeFileInput
	if err := unmarshalInput(input, &in); err != nil {
		return "", err
	}
	p, err := ResolveInWorkspace(env, in.Path)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	existed := false
	if _, err := os.Stat(p); err == nil {
		existed = true
	}
	if err := os.WriteFile(p, []byte(in.Content), 0o644); err != nil {
		return "", err
	}
	action := "已创建"
	if existed {
		action = "已覆盖"
	}
	return fmt.Sprintf("%s %s(%d 字节)", action, in.Path, len(in.Content)), nil
}
