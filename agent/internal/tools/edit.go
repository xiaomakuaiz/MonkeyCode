package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// EditFile 精确字符串替换编辑。
type EditFile struct{}

type editFileInput struct {
	Path       string `json:"path"`
	OldString  string `json:"old_string"`
	NewString  string `json:"new_string"`
	ReplaceAll bool   `json:"replace_all"`
}

func (t *EditFile) Name() string { return "edit_file" }

func (t *EditFile) Description() string {
	return "对文件做精确字符串替换。old_string 必须与文件内容逐字符一致(含缩进与换行), " +
		"且默认必须在文件中唯一;不唯一时可增加上下文使其唯一,或设 replace_all 替换全部。"
}

func (t *EditFile) InputSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path":        map[string]any{"type": "string", "description": "文件路径(相对工作区或绝对路径)"},
			"old_string":  map[string]any{"type": "string", "description": "要替换的原文(逐字符精确匹配)"},
			"new_string":  map[string]any{"type": "string", "description": "替换后的新文本"},
			"replace_all": map[string]any{"type": "boolean", "description": "替换所有出现(默认 false,要求唯一)"},
		},
		"required": []string{"path", "old_string", "new_string"},
	}
}

func (t *EditFile) Title(input json.RawMessage) string {
	var in editFileInput
	_ = json.Unmarshal(input, &in)
	return "编辑 " + in.Path
}

func (t *EditFile) Execute(_ context.Context, env *Env, input json.RawMessage) (string, error) {
	var in editFileInput
	if err := unmarshalInput(input, &in); err != nil {
		return "", err
	}
	if in.OldString == in.NewString {
		return "", fmt.Errorf("old_string 与 new_string 相同,无需编辑")
	}
	if in.OldString == "" {
		return "", fmt.Errorf("old_string 不能为空;创建新文件请用 write_file")
	}
	p, err := ResolveInWorkspace(env, in.Path)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return "", fmt.Errorf("无法读取 %s: %w", in.Path, err)
	}
	content := string(data)

	count := strings.Count(content, in.OldString)
	switch {
	case count == 0:
		return "", fmt.Errorf("在 %s 中找不到 old_string。请先 read_file 确认内容,注意缩进、空格和换行必须逐字符一致", in.Path)
	case count > 1 && !in.ReplaceAll:
		return "", fmt.Errorf("old_string 在 %s 中出现 %d 次,无法确定替换目标。请增加上下文使其唯一,或设置 replace_all=true", in.Path, count)
	}

	var newContent string
	replaced := 1
	if in.ReplaceAll {
		newContent = strings.ReplaceAll(content, in.OldString, in.NewString)
		replaced = count
	} else {
		newContent = strings.Replace(content, in.OldString, in.NewString, 1)
	}

	st, _ := os.Stat(p)
	mode := os.FileMode(0o644)
	if st != nil {
		mode = st.Mode()
	}
	if err := os.WriteFile(p, []byte(newContent), mode); err != nil {
		return "", err
	}
	return fmt.Sprintf("已编辑 %s(替换 %d 处)", in.Path, replaced), nil
}
