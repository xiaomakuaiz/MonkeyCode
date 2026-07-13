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

// Bash 执行 shell 命令。每次调用独立进程,但工作目录与导出的环境变量
// 在调用间保持(cwd 经输出标记跟踪;env 经 export -p 落盘、下次调用 source)。
type Bash struct {
	cwd     string // 跨调用保持的当前目录;空表示工作区根
	envFile string // 跨调用保持的 env 快照文件;惰性创建
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
		// Windows 暂不支持 env 跨调用保持
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-Command",
			in.Command+"; Write-Output ('"+cwdMarker+"' + (Get-Location).Path)")
	} else {
		cmd = exec.CommandContext(ctx, "bash", "-c", t.wrapPOSIX(in.Command))
	}
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "CI=true", "TERM=dumb")
	setProcAttrs(cmd)
	cmd.Cancel = func() error { return killProcessGroup(cmd) }
	cmd.WaitDelay = 5 * time.Second

	// 合并输出;执行期经进度通道节流上报最新完整行(长命令可见进展)
	pw := &progressWriter{env: env}
	cmd.Stdout = pw
	cmd.Stderr = pw
	runErr := cmd.Run()

	// 提取并剥离 cwd 标记
	text := pw.buf.String()
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

// progressWriter 收集命令输出,并以 ≥500ms 的间隔把最新完整输出行
// 经进度通道上报(跳过内部 cwd 标记行)。cmd.Run 的写入是串行的,无需加锁。
type progressWriter struct {
	buf      strings.Builder
	env      *Env
	lastEmit time.Time
}

func (w *progressWriter) Write(p []byte) (int, error) {
	w.buf.Write(p)
	if w.env.Progress == nil || time.Since(w.lastEmit) < 500*time.Millisecond {
		return len(p), nil
	}
	if line := lastCompleteLine(w.buf.String()); line != "" {
		w.lastEmit = time.Now()
		w.env.EmitProgress(ProgressUpdate{Kind: "output", Line: truncateStr(line, 160)})
	}
	return len(p), nil
}

// lastCompleteLine 取最近一个非空且非内部标记的完整行。
func lastCompleteLine(s string) string {
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	} else {
		return ""
	}
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line != "" && !strings.Contains(line, cwdMarker) {
			return line
		}
	}
	return ""
}

// wrapPOSIX 包装用户命令:恢复上次导出的 env → 执行 → 落盘 env 快照 →
// 输出 cwd 标记,并保持用户命令的退出码。
func (t *Bash) wrapPOSIX(command string) string {
	if t.envFile == "" {
		f, err := os.CreateTemp("", "mc-agent-env-*")
		if err == nil {
			t.envFile = f.Name()
			_ = f.Close()
		}
	}
	if t.envFile == "" {
		// 拿不到临时文件就退化为无 env 保持
		return command + "\nprintf '\\n%s%s' '" + cwdMarker + "' \"$PWD\""
	}
	return `{ [ -s '` + t.envFile + `' ] && . '` + t.envFile + `'; } 2>/dev/null
` + command + `
__mc_rc=$?
{ export -p | grep -vE '^declare -x (PWD|OLDPWD|SHLVL|_|PS1|BASH[A-Z_]*)=' > '` + t.envFile + `'; } 2>/dev/null
printf '\n%s%s' '` + cwdMarker + `' "$PWD"
exit $__mc_rc`
}

// Close 清理跨调用状态(会话结束时调用)。
func (t *Bash) Close() {
	if t.envFile != "" {
		_ = os.Remove(t.envFile)
		t.envFile = ""
	}
}
