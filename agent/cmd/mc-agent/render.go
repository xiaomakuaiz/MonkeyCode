package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"

	"golang.org/x/term"

	"github.com/chaitin/MonkeyCode/agent/internal/frame"
)

// ANSI 颜色。
const (
	cReset = "\033[0m"
	cDim   = "\033[2m"
	cCyan  = "\033[36m"
	cGreen = "\033[32m"
	cRed   = "\033[31m"
	cBold  = "\033[1m"
)

// Renderer 把帧渲染到终端(实现 frame.Emitter)。
type Renderer struct {
	mu        sync.Mutex
	color     bool
	midLine   bool   // 当前输出停在行中
	streaming string // "text" | "thought" | ""
	Quiet     bool   // 只输出正文(供脚本/eval 用)
}

// NewRenderer 创建渲染器。
func NewRenderer() *Renderer {
	return &Renderer{color: isTerminal(os.Stdout) && os.Getenv("NO_COLOR") == ""}
}

// isTerminal 判断是否为真正的 TTY(/dev/null 是字符设备但非 TTY,须排除)。
func isTerminal(f *os.File) bool {
	return term.IsTerminal(int(f.Fd()))
}

func (r *Renderer) paint(code, s string) string {
	if !r.color {
		return s
	}
	return code + s + cReset
}

// ensureNewline 结束流式行,保证后续输出从行首开始。
func (r *Renderer) ensureNewline() {
	if r.midLine {
		fmt.Println()
		r.midLine = false
	}
	if r.streaming == "thought" && r.color {
		fmt.Print(cReset)
	}
	r.streaming = ""
}

type acpUpdate struct {
	Update struct {
		SessionUpdate string `json:"sessionUpdate"`
		Content       struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		ToolCallID string            `json:"toolCallId"`
		Title      string            `json:"title"`
		Kind       string            `json:"kind"`
		Status     string            `json:"status"`
		RawOutput  any               `json:"rawOutput"`
		Entries    []frame.PlanEntry `json:"entries"`
		Attempt    int               `json:"attempt"`
		Message    string            `json:"message"`
	} `json:"update"`
}

// Emit 实现 frame.Emitter。
func (r *Renderer) Emit(f frame.Frame) {
	r.mu.Lock()
	defer r.mu.Unlock()

	switch f.Type {
	case frame.TypeTaskError:
		r.ensureNewline()
		var p struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(f.Data, &p)
		fmt.Fprintln(os.Stderr, r.paint(cRed, "✗ "+p.Error))
	case frame.TypeTaskRunning:
		if f.Kind != frame.KindACPEvent {
			return
		}
		var u acpUpdate
		if json.Unmarshal(f.Data, &u) != nil {
			return
		}
		r.renderUpdate(&u)
	}
}

func (r *Renderer) renderUpdate(u *acpUpdate) {
	up := &u.Update
	switch up.SessionUpdate {
	case "agent_message_chunk":
		if r.streaming != "text" {
			r.ensureNewline()
			r.streaming = "text"
		}
		fmt.Print(up.Content.Text)
		r.midLine = !strings.HasSuffix(up.Content.Text, "\n")
	case "agent_thought_chunk":
		if r.Quiet {
			return
		}
		if r.streaming != "thought" {
			r.ensureNewline()
			r.streaming = "thought"
			if r.color {
				fmt.Print(cDim)
			}
		}
		fmt.Print(up.Content.Text)
		r.midLine = !strings.HasSuffix(up.Content.Text, "\n")
	case "tool_call":
		r.ensureNewline()
		if r.Quiet {
			return
		}
		fmt.Println(r.paint(cCyan, "⏺ "+up.Title))
	case "tool_call_update":
		if r.Quiet || up.Status == "in_progress" {
			return
		}
		r.ensureNewline()
		mark := r.paint(cGreen, "  ✓")
		if up.Status == "failed" {
			mark = r.paint(cRed, "  ✗")
		}
		summary := ""
		if s, ok := up.RawOutput.(string); ok {
			summary = firstLine(s)
		}
		fmt.Printf("%s %s\n", mark, r.paint(cDim, summary))
	case "plan":
		if r.Quiet {
			return
		}
		r.ensureNewline()
		fmt.Println(r.paint(cBold, "计划:"))
		for _, e := range up.Entries {
			mark := map[string]string{"pending": "[ ]", "in_progress": "[~]", "completed": "[x]"}[e.Status]
			fmt.Printf("  %s %s\n", mark, e.Content)
		}
	case "llm_call_retry":
		r.ensureNewline()
		fmt.Fprintln(os.Stderr, r.paint(cDim,
			fmt.Sprintf("模型调用失败,正在重试第 %d 次: %s", up.Attempt, firstLine(up.Message))))
	case "compact_status":
		if r.Quiet {
			return
		}
		r.ensureNewline()
		if up.Status == "started" {
			fmt.Println(r.paint(cDim, "⟳ 上下文接近上限,正在压缩…"))
		} else {
			fmt.Println(r.paint(cDim, "⟳ 上下文压缩完成"))
		}
	}
}

// Flush 收尾换行。
func (r *Renderer) Flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensureNewline()
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 120 {
		s = s[:120] + "..."
	}
	return s
}
