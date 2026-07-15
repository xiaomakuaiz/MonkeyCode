package loop

import "github.com/chaitin/MonkeyCode/agent/internal/provider"

// RepairHistory 修复损坏的消息历史:为没有配对 tool_result 的 tool_use
// 补合成的错误结果。旧版本在中断时丢弃整批工具结果,落盘的历史会让
// 后续所有请求被 API 拒绝("tool_use 缺少 tool_result");会话加载时
// 过一遍本函数即可救活。历史完好时原样返回。
func RepairHistory(msgs []provider.Message) []provider.Message {
	out := make([]provider.Message, 0, len(msgs))
	for i := 0; i < len(msgs); i++ {
		m := msgs[i]
		out = append(out, m)
		if m.Role != provider.RoleAssistant {
			continue
		}
		var uses []string
		for _, b := range m.Content {
			if b.Type == provider.BlockToolUse {
				uses = append(uses, b.ID)
			}
		}
		if len(uses) == 0 {
			continue
		}
		// tool_result 只可能出现在紧随其后的 user 消息里
		have := map[string]bool{}
		nextIsUser := i+1 < len(msgs) && msgs[i+1].Role == provider.RoleUser
		if nextIsUser {
			for _, b := range msgs[i+1].Content {
				if b.Type == provider.BlockToolResult {
					have[b.ToolUseID] = true
				}
			}
		}
		var synth []provider.ContentBlock
		for _, id := range uses {
			if !have[id] {
				synth = append(synth, provider.ContentBlock{
					Type: provider.BlockToolResult, ToolUseID: id,
					Content: "工具执行结果丢失(该轮次曾被中断),如仍需要请重新执行", IsError: true,
				})
			}
		}
		if len(synth) == 0 {
			continue
		}
		if nextIsUser {
			// 补进下一条 user 消息头部(tool_result 须位于文本块之前)
			next := msgs[i+1]
			next.Content = append(synth, next.Content...)
			out = append(out, next)
			i++
		} else {
			out = append(out, provider.Message{Role: provider.RoleUser, Content: synth})
		}
	}
	return out
}
