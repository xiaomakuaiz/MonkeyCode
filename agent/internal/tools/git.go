package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// gitAllowed git 工具允许的只读子命令;提交/推送等写操作走 bash(经权限审批)。
var gitAllowed = map[string]bool{
	"status": true, "diff": true, "log": true, "show": true,
	"branch": true, "blame": true, "remote": true, "stash": true, "ls-files": true,
}

// Git 只读 git 查询(状态/diff/历史)。
type Git struct{}

type gitInput struct {
	Subcommand string   `json:"subcommand"`
	Args       []string `json:"args"`
}

func (t *Git) Name() string { return "git" }

func (t *Git) Description() string {
	return "执行只读 git 查询:status/diff/log/show/branch/blame/remote/stash list/ls-files。" +
		"commit、push 等写操作请用 bash 工具。"
}

func (t *Git) InputSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"subcommand": map[string]any{"type": "string", "description": "git 子命令,如 status、diff、log"},
			"args":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "附加参数,如 [\"--stat\"]、[\"HEAD~3..\"]"},
		},
		"required": []string{"subcommand"},
	}
}

func (t *Git) Title(input json.RawMessage) string {
	var in gitInput
	_ = json.Unmarshal(input, &in)
	return "git " + in.Subcommand + " " + truncateStr(strings.Join(in.Args, " "), 50)
}

func (t *Git) Execute(ctx context.Context, env *Env, input json.RawMessage) (string, error) {
	var in gitInput
	if err := unmarshalInput(input, &in); err != nil {
		return "", err
	}
	if !gitAllowed[in.Subcommand] {
		return "", fmt.Errorf("git 工具仅支持只读子命令(%s);%q 请改用 bash 工具执行",
			strings.Join(allowedList(), "/"), in.Subcommand)
	}
	for _, a := range in.Args {
		// 阻止通过参数走到写路径或任意命令执行
		if strings.HasPrefix(a, "--output") || a == "--exec" || strings.HasPrefix(a, "--upload-pack") {
			return "", fmt.Errorf("参数 %q 不被允许", a)
		}
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	args := append([]string{"-c", "color.ui=false", in.Subcommand}, in.Args...)
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = env.Workdir
	out, err := cmd.CombinedOutput()
	text := truncateOutput(string(out), 48*1024)
	if err != nil {
		return fmt.Sprintf("git 命令失败: %v\n%s", err, text), nil
	}
	if strings.TrimSpace(text) == "" {
		text = "(无输出)"
	}
	return text, nil
}

func allowedList() []string {
	out := make([]string, 0, len(gitAllowed))
	for k := range gitAllowed {
		out = append(out, k)
	}
	return out
}
