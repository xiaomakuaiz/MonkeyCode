package provider

import (
	"encoding/json"
	"strings"
)

// NormalizeToolInput 归一化模型产出的工具参数 JSON。
// 弱模型常见问题:包 markdown 代码栅栏、尾逗号、JSON 前后混入解释文本。
// 修复失败时原样返回,由上层把解析错误反馈给模型重试。
func NormalizeToolInput(raw string) json.RawMessage {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return json.RawMessage("{}")
	}
	if json.Valid([]byte(raw)) {
		return json.RawMessage(raw)
	}

	candidates := []string{
		stripCodeFence(raw),
		extractJSONObject(raw),
		removeTrailingCommas(stripCodeFence(raw)),
		removeTrailingCommas(extractJSONObject(raw)),
	}
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c != "" && json.Valid([]byte(c)) {
			return json.RawMessage(c)
		}
	}
	return json.RawMessage(raw)
}

// stripCodeFence 去掉 ```json ... ``` 栅栏。
func stripCodeFence(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	s = strings.TrimPrefix(s, "```")
	// 去掉语言标记行
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		first := strings.TrimSpace(s[:i])
		if len(first) <= 10 && !strings.ContainsAny(first, "{}[]") {
			s = s[i+1:]
		}
	}
	s = strings.TrimSuffix(strings.TrimSpace(s), "```")
	return strings.TrimSpace(s)
}

// extractJSONObject 提取第一个括号配平的 {...} 或 [...] 片段(忽略字符串字面量内的括号)。
func extractJSONObject(s string) string {
	start := -1
	var open, close byte
	for i := 0; i < len(s); i++ {
		if s[i] == '{' {
			start, open, close = i, '{', '}'
			break
		}
		if s[i] == '[' {
			start, open, close = i, '[', ']'
			break
		}
	}
	if start < 0 {
		return ""
	}
	depth := 0
	inStr := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inStr {
			switch c {
			case '\\':
				i++
			case '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case open:
			depth++
		case close:
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return ""
}

// removeTrailingCommas 移除 } ] 前的尾逗号(跳过字符串字面量)。
func removeTrailingCommas(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inStr := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inStr {
			b.WriteByte(c)
			if c == '\\' && i+1 < len(s) {
				i++
				b.WriteByte(s[i])
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		if c == '"' {
			inStr = true
			b.WriteByte(c)
			continue
		}
		if c == ',' {
			j := i + 1
			for j < len(s) && (s[j] == ' ' || s[j] == '\n' || s[j] == '\t' || s[j] == '\r') {
				j++
			}
			if j < len(s) && (s[j] == '}' || s[j] == ']') {
				continue // 丢弃尾逗号
			}
		}
		b.WriteByte(c)
	}
	return b.String()
}
