package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

const (
	bashDefaultTimeout = 120 * time.Second
	bashMaxTimeout     = 600 * time.Second
	bashMaxOutput      = 64 * 1024
	cwdMarker          = "__MC_AGENT_CWD__"
)

// Bash 执行 shell 命令。每次调用独立进程,但工作目录在调用间保持
// (通过命令尾部的 pwd 标记跟踪)。
type Bash struct {
	cwd string // 跨调用保持的当前目录;空表示工作区根
}

type bashInput struct {
	Command   string `json:"command"`
	TimeoutMS int    `json:"timeout_ms"`
}

func (t *Bash) Name() string { return "bash" }

func (t *Bash) Description() string {
	return "在工作区内执行 shell 命令(Linux/macOS 为 bash,Windows 为 PowerShell)。" +
		"cd 的效果会保持到后续调用。输出过长会被截断;禁止交互式命令。"
}

func (t *Bash) InputSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"command":    map[string]any{"type": "string", "description": "要执行的命令"},
			"timeout_ms": map[string]any{"type": "integer", "description": "超时毫秒数(默认 120000,最大 600000)"},
		},
		"required": []string{"command"},
	}
}

func (t *Bash) Title(input json.RawMessage) string {
	var in bashInput
	_ = json.Unmarshal(input, &in)
	return "执行 " + truncateStr(strings.TrimSpace(in.Command), 80)
}

func (t *Bash) Execute(ctx context.Context, env *Env, input json.RawMessage) (string, error) {
	var in bashInput
	if err := unmarshalInput(input, &in); err != nil {
		return "", err
	}
	if strings.TrimSpace(in.Command) == "" {
		return "", fmt.Errorf("command 不能为空")
	}

	timeout := bashDefaultTimeout
	if in.TimeoutMS > 0 {
		timeout = min(time.Duration(in.TimeoutMS)*time.Millisecond, bashMaxTimeout)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cwd := t.cwd
	if cwd == "" {
		cwd = env.Workdir
	}
	if _, err := os.Stat(cwd); err != nil {
		cwd = env.Workdir
	}

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-Command",
			in.Command+"; Write-Output ('"+cwdMarker+"' + (Get-Location).Path)")
	} else {
		cmd = exec.CommandContext(ctx, "bash", "-c",
			in.Command+"\nprintf '\\n%s%s' '"+cwdMarker+"' \"$PWD\"")
	}
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "CI=true", "TERM=dumb")
	setProcAttrs(cmd)
	cmd.Cancel = func() error { return killProcessGroup(cmd) }
	cmd.WaitDelay = 5 * time.Second

	out, runErr := cmd.CombinedOutput()

	// 提取并剥离 cwd 标记
	text := string(out)
	if i := strings.LastIndex(text, cwdMarker); i >= 0 {
		newCwd := strings.TrimSpace(text[i+len(cwdMarker):])
		text = strings.TrimRight(text[:i], "\n")
		if newCwd != "" {
			if resolved, err := ResolveInWorkspace(env, newCwd); err == nil {
				t.cwd = resolved
			} else {
				t.cwd = env.Workdir // cd 出了工作区则拉回
				text += "\n[提示] 工作目录已超出工作区,已重置回工作区根目录"
			}
		}
	}
	text = truncateOutput(text, bashMaxOutput)

	if ctx.Err() == context.DeadlineExceeded {
		return "", fmt.Errorf("命令超时(%s)已被终止。输出:\n%s", timeout, text)
	}
	if runErr != nil {
		// 非零退出码:把输出还给模型,属正常工具结果而非系统错误
		return fmt.Sprintf("命令失败: %v\n%s", runErr, text), nil
	}
	if strings.TrimSpace(text) == "" {
		text = "(无输出)"
	}
	return text, nil
}
