package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/chaitin/MonkeyCode/agent/internal/tools"
)

const callTimeout = 60 * time.Second

// agentTool 把一个 MCP tool 适配为内核 tools.Tool。
type agentTool struct {
	server *Server
	tool   *sdk.Tool
}

// ToolName MCP 工具的内核侧名称:mcp__<server>__<tool>。
func ToolName(server, tool string) string {
	return "mcp__" + server + "__" + tool
}

func (t *agentTool) Name() string { return ToolName(t.server.Name, t.tool.Name) }

func (t *agentTool) Description() string {
	desc := strings.TrimSpace(t.tool.Description)
	if desc == "" {
		desc = t.tool.Name
	}
	return fmt.Sprintf("[MCP:%s] %s", t.server.Name, desc)
}

func (t *agentTool) InputSchema() map[string]any {
	if m, ok := t.tool.InputSchema.(map[string]any); ok && m != nil {
		return m
	}
	// 其它形态(json.RawMessage 等)统一走一次序列化归一
	data, err := json.Marshal(t.tool.InputSchema)
	if err == nil {
		var m map[string]any
		if json.Unmarshal(data, &m) == nil && m != nil {
			return m
		}
	}
	return map[string]any{"type": "object"}
}

// ReadOnly server 是否声明了只读注解(policy 据此放行)。
func (t *agentTool) ReadOnly() bool {
	return t.tool.Annotations != nil && t.tool.Annotations.ReadOnlyHint
}

func (t *agentTool) Title(input json.RawMessage) string {
	arg := ""
	var m map[string]any
	if json.Unmarshal(input, &m) == nil {
		// 取第一个短字符串参数做展示,避免标题里塞整个 JSON
		for _, v := range m {
			if s, ok := v.(string); ok && s != "" {
				arg = truncateStr(s, 50)
				break
			}
		}
	}
	title := fmt.Sprintf("MCP %s:%s", t.server.Name, t.tool.Name)
	if arg != "" {
		title += " " + arg
	}
	return title
}

func (t *agentTool) Execute(ctx context.Context, _ *tools.Env, input json.RawMessage) (string, error) {
	var args map[string]any
	if len(input) > 0 {
		if err := json.Unmarshal(input, &args); err != nil {
			return "", fmt.Errorf("工具参数 JSON 解析失败: %v。请修正参数后重试", err)
		}
	}

	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	res, err := t.server.Session.CallTool(cctx, &sdk.CallToolParams{
		Name:      t.tool.Name,
		Arguments: args,
	})
	if err != nil {
		if cctx.Err() == context.DeadlineExceeded {
			return "", fmt.Errorf("MCP 工具调用超时(%s)", callTimeout)
		}
		return "", fmt.Errorf("MCP 工具调用失败: %w", err)
	}

	text := renderResult(res)
	if res.IsError {
		return "", fmt.Errorf("MCP 工具返回错误: %s", truncateStr(text, 2000))
	}
	if strings.TrimSpace(text) == "" {
		text = "(无输出)"
	}
	return truncateOutput(text, 48*1024), nil
}

// renderResult 拼接结果内容:text 块优先,空则回退 structuredContent。
func renderResult(res *sdk.CallToolResult) string {
	var parts []string
	for _, c := range res.Content {
		switch v := c.(type) {
		case *sdk.TextContent:
			parts = append(parts, v.Text)
		case *sdk.ImageContent:
			parts = append(parts, fmt.Sprintf("[图片内容 %s,%d 字节,当前不支持展示]", v.MIMEType, len(v.Data)))
		default:
			parts = append(parts, fmt.Sprintf("[不支持的内容类型 %T]", c))
		}
	}
	out := strings.Join(parts, "\n")
	if strings.TrimSpace(out) == "" && res.StructuredContent != nil {
		if data, err := json.Marshal(res.StructuredContent); err == nil {
			out = string(data)
		}
	}
	return out
}

func truncateStr(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}

func truncateOutput(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	head := maxBytes * 2 / 3
	tail := maxBytes / 3
	return s[:head] + fmt.Sprintf("\n\n...[输出过长,已截断 %d 字节]...\n\n", len(s)-head-tail) + s[len(s)-tail:]
}
