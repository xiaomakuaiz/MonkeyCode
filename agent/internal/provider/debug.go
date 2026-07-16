package provider

import (
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

var dumpSeq atomic.Int64

// dumpLLMRequest 调试开关:环境变量 MC_AGENT_DUMP_LLM 指向目录时,把每次
// LLM 请求体按发出的原始字节落盘(llm-时刻-序号.json,0600)。用于排查
// "发给模型的载荷是否完整"一类问题——日志查看器普遍会折叠超长字符串,
// 只有落盘字节才是权威依据。
func dumpLLMRequest(body []byte) {
	dir := os.Getenv("MC_AGENT_DUMP_LLM")
	if dir == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	name := fmt.Sprintf("llm-%s-%d.json", time.Now().Format("150405"), dumpSeq.Add(1))
	_ = os.WriteFile(filepath.Join(dir, name), body, 0o600)
}
