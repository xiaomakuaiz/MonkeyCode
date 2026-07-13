// Package policy 工具执行的权限规则引擎。
//
// 决策维度:工具名 × 路径 × 命令前缀,动作 allow / deny / ask。
// 本地没有 VM 沙箱兜底,写操作与未知命令默认询问用户。
package policy

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// Decision 决策结果。
type Decision string

const (
	Allow Decision = "allow"
	Deny  Decision = "deny"
	Ask   Decision = "ask"
)

// Request 一次工具调用的审批请求。
type Request struct {
	Tool  string
	Title string
	Input json.RawMessage
}

// Asker 审批回调:返回是否允许,以及是否记住该决定(本会话内)。
type Asker func(ctx context.Context, req Request) (approved, remember bool, err error)

// Engine 规则引擎。
type Engine struct {
	mu   sync.Mutex
	mode Mode
	ask  Asker
	// 会话内记住的决定,key 为 remember key(工具名或 bash 命令首词)
	remembered map[string]Decision
}

// Mode 引擎模式。
type Mode string

const (
	ModeDefault Mode = "default" // 只读放行,写/未知命令询问
	ModeYolo    Mode = "yolo"    // 全部放行(eval 与受信环境用)
)

// New 创建引擎。asker 为 nil 时,所有 Ask 决策按拒绝处理。
func New(mode Mode, ask Asker) *Engine {
	return &Engine{mode: mode, ask: ask, remembered: map[string]Decision{}}
}

// 只读工具,始终放行(自身已强制工作区边界)。
var readonlyTools = map[string]bool{
	"read_file": true, "grep": true, "glob": true, "git": true, "todo": true,
}

// bash 命令首词放行清单(只读/常规构建类)。
var bashAllowedPrefixes = []string{
	"ls", "cat", "head", "tail", "wc", "pwd", "echo", "which", "file", "stat", "du", "df",
	"grep", "rg", "find", "sort", "uniq", "cut", "awk", "sed -n", "diff", "tree", "env",
	"git status", "git diff", "git log", "git show", "git branch", "git add", "git stash list",
	"go build", "go test", "go vet", "go run", "go mod", "go fmt", "gofmt",
	"npm test", "npm run", "npx tsc", "yarn test", "pnpm test", "node ",
	"python ", "python3 ", "pytest", "pip list", "pip show",
	"make ", "make", "cargo build", "cargo test", "cargo check",
	"mkdir", "touch", "cd ",
}

// bash 危险命令,直接拒绝。
var bashDeniedPatterns = []string{
	"rm -rf /", "rm -rf ~", "rm -rf .", ":(){", "mkfs", "dd if=", "> /dev/",
	"shutdown", "reboot", "sudo ", "chmod -R 777 /",
}

// Check 检查一次工具调用,必要时经 asker 请求用户审批。
// 返回 nil 表示允许执行;否则返回携带拒绝原因的 error(作为工具结果反馈给模型)。
func (e *Engine) Check(ctx context.Context, req Request) error {
	d, rememberKey := e.decide(req)
	switch d {
	case Allow:
		return nil
	case Deny:
		return fmt.Errorf("该操作被安全策略拒绝: %s", req.Title)
	}

	// Ask:先查会话内记住的决定
	e.mu.Lock()
	if prev, ok := e.remembered[rememberKey]; ok {
		e.mu.Unlock()
		if prev == Allow {
			return nil
		}
		return fmt.Errorf("用户此前已拒绝同类操作: %s", req.Title)
	}
	e.mu.Unlock()

	if e.ask == nil {
		return fmt.Errorf("操作需要用户审批但当前为非交互模式,已拒绝: %s。可用 --yolo 或 --allow 预授权", req.Title)
	}
	approved, remember, err := e.ask(ctx, req)
	if err != nil {
		return fmt.Errorf("审批失败: %w", err)
	}
	if remember {
		e.mu.Lock()
		if approved {
			e.remembered[rememberKey] = Allow
		} else {
			e.remembered[rememberKey] = Deny
		}
		e.mu.Unlock()
	}
	if !approved {
		return fmt.Errorf("用户拒绝了该操作: %s", req.Title)
	}
	return nil
}

// AllowTool 预授权某个工具(--allow write_file 等价于会话内记住 allow)。
func (e *Engine) AllowTool(name string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.remembered[name] = Allow
}

func (e *Engine) decide(req Request) (Decision, string) {
	if e.mode == ModeYolo {
		return Allow, req.Tool
	}
	if readonlyTools[req.Tool] {
		return Allow, req.Tool
	}
	switch req.Tool {
	case "write_file", "edit_file":
		return Ask, req.Tool
	case "bash":
		var in struct {
			Command string `json:"command"`
		}
		_ = json.Unmarshal(req.Input, &in)
		cmd := strings.TrimSpace(in.Command)
		lower := strings.ToLower(cmd)
		for _, p := range bashDeniedPatterns {
			if strings.Contains(lower, p) {
				return Deny, "bash"
			}
		}
		if allowedBashCommand(cmd) {
			return Allow, "bash:" + firstWord(cmd)
		}
		return Ask, "bash:" + firstWord(cmd)
	default:
		return Ask, req.Tool
	}
}

// allowedBashCommand 命令(含 && ; | 连接的每一段)都在放行清单内才放行。
func allowedBashCommand(cmd string) bool {
	segments := splitCommand(cmd)
	if len(segments) == 0 {
		return false
	}
	for _, seg := range segments {
		seg = strings.TrimSpace(seg)
		if seg == "" {
			continue
		}
		if !hasAllowedPrefix(seg) {
			return false
		}
	}
	return true
}

func hasAllowedPrefix(seg string) bool {
	for _, p := range bashAllowedPrefixes {
		if seg == strings.TrimSpace(p) || strings.HasPrefix(seg, p) {
			// 前缀是完整词(如 "ls" 匹配 "ls -la" 但不匹配 "lsof")
			rest := seg[len(p):]
			if rest == "" || rest[0] == ' ' || strings.HasSuffix(p, " ") {
				return true
			}
		}
	}
	return false
}

// splitCommand 按 && || ; | 粗粒度拆分命令(忽略引号内的分隔符)。
func splitCommand(cmd string) []string {
	var segs []string
	var cur strings.Builder
	inSingle, inDouble := false, false
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			segs = append(segs, s)
		}
		cur.Reset()
	}
	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		switch {
		case inSingle:
			if c == '\'' {
				inSingle = false
			}
			cur.WriteByte(c)
		case inDouble:
			if c == '"' {
				inDouble = false
			}
			cur.WriteByte(c)
		case c == '\'':
			inSingle = true
			cur.WriteByte(c)
		case c == '"':
			inDouble = true
			cur.WriteByte(c)
		case c == ';' || c == '|':
			flush()
		case c == '&' && i+1 < len(cmd) && cmd[i+1] == '&':
			flush()
			i++
		case c == '\n':
			flush()
		default:
			cur.WriteByte(c)
		}
	}
	flush()
	return segs
}

func firstWord(s string) string {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}
