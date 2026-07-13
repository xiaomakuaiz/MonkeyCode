package frame

import (
	"encoding/base64"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// --- 辅助函数 ---

// decodeData 解码 Frame.Data(base64→JSON→any),返回 map 方便断言。
func decodeData(t *testing.T, fr Frame) map[string]any {
	t.Helper()
	if len(fr.Data) == 0 {
		return nil
	}
	var envelope map[string]any
	if err := json.Unmarshal(fr.Data, &envelope); err != nil {
		t.Fatalf("data 反序列化失败: %v (raw=%q)", err, string(fr.Data))
	}
	return envelope
}

// getUpdate 从 data 中取 "update" 并断言为 map。
func getUpdate(t *testing.T, fr Frame) map[string]any {
	t.Helper()
	env := decodeData(t, fr)
	upd, ok := env["update"]
	if !ok {
		t.Fatalf("data 缺少 update 字段: %v", env)
	}
	m, ok := upd.(map[string]any)
	if !ok {
		t.Fatalf("update 不是 object: %T", upd)
	}
	return m
}

func newBuilder() *Builder { return &Builder{} }

// ===================== Builder seq / timestamp =====================

func TestBuilderSeqIncrement(t *testing.T) {
	b := newBuilder()
	prev := uint64(0)
	for i := 0; i < 10; i++ {
		fr := b.AgentText("x")
		if fr.Seq <= prev {
			t.Fatalf("seq 未递增: prev=%d cur=%d", prev, fr.Seq)
		}
		prev = fr.Seq
	}
	// 第一个 seq 应 >= 1
	fr := b.AgentText("y")
	if fr.Seq < 1 {
		t.Fatalf("首个 seq 应 >= 1: %d", fr.Seq)
	}
}

func TestBuilderTimestamp(t *testing.T) {
	b := newBuilder()
	before := time.Now().UnixMilli()
	fr := b.AgentText("ts")
	after := time.Now().UnixMilli()
	if fr.Timestamp < before || fr.Timestamp > after {
		t.Fatalf("timestamp 不在合理范围: ts=%d before=%d after=%d", fr.Timestamp, before, after)
	}
}

func TestBuilderSeqThreadSafe(t *testing.T) {
	b := newBuilder()
	var wg sync.WaitGroup
	n := 100
	seqs := make([]uint64, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			seqs[idx] = b.AgentText("x").Seq
		}(i)
	}
	wg.Wait()
	// 所有 seq 必须唯一
	seen := map[uint64]bool{}
	for _, s := range seqs {
		if s == 0 {
			t.Fatal("seq 不应为 0")
		}
		if seen[s] {
			t.Fatalf("seq 重复: %d", s)
		}
		seen[s] = true
	}
}

// ===================== AgentText / AgentThought =====================

func TestAgentText(t *testing.T) {
	b := newBuilder()
	fr := b.AgentText("hello world")
	if fr.Type != TypeTaskRunning {
		t.Fatalf("type: want=%s got=%s", TypeTaskRunning, fr.Type)
	}
	if fr.Kind != KindACPEvent {
		t.Fatalf("kind: want=%s got=%s", KindACPEvent, fr.Kind)
	}

	upd := getUpdate(t, fr)
	if upd["sessionUpdate"] != "agent_message_chunk" {
		t.Fatalf("sessionUpdate: want=agent_message_chunk got=%v", upd["sessionUpdate"])
	}
	c, ok := upd["content"].(map[string]any)
	if !ok {
		t.Fatalf("content 不是 object: %T", upd["content"])
	}
	if c["type"] != "text" {
		t.Fatalf("content.type: want=text got=%v", c["type"])
	}
	if c["text"] != "hello world" {
		t.Fatalf("content.text: want=hello world got=%v", c["text"])
	}
}

func TestAgentThought(t *testing.T) {
	b := newBuilder()
	fr := b.AgentThought("thinking...")
	if fr.Type != TypeTaskRunning || fr.Kind != KindACPEvent {
		t.Fatalf("type=%s kind=%s", fr.Type, fr.Kind)
	}
	upd := getUpdate(t, fr)
	if upd["sessionUpdate"] != "agent_thought_chunk" {
		t.Fatalf("sessionUpdate=%v", upd["sessionUpdate"])
	}
	c := upd["content"].(map[string]any)
	if c["type"] != "text" || c["text"] != "thinking..." {
		t.Fatalf("content=%v", c)
	}
}

// ===================== ToolCall / ToolCallUpdate =====================

func TestToolCall(t *testing.T) {
	b := newBuilder()
	fr := b.ToolCall(ToolCallUpdate{
		ToolCallID: "tc-001",
		Title:      "read_file",
		Kind:       "read",
		Status:     "in_progress",
		RawInput:   map[string]string{"path": "/x"},
	})
	upd := getUpdate(t, fr)
	if upd["sessionUpdate"] != "tool_call" {
		t.Fatalf("sessionUpdate=%v", upd["sessionUpdate"])
	}
	if upd["toolCallId"] != "tc-001" {
		t.Fatalf("toolCallId=%v", upd["toolCallId"])
	}
	if upd["title"] != "read_file" {
		t.Fatalf("title=%v", upd["title"])
	}
	if upd["kind"] != "read" {
		t.Fatalf("kind=%v", upd["kind"])
	}
	if upd["status"] != "in_progress" {
		t.Fatalf("status=%v", upd["status"])
	}
	ri, ok := upd["rawInput"].(map[string]any)
	if !ok || ri["path"] != "/x" {
		t.Fatalf("rawInput=%v", upd["rawInput"])
	}
}

func TestToolCallUpdate(t *testing.T) {
	b := newBuilder()
	fr := b.ToolCallUpdate(ToolCallUpdate{
		ToolCallID: "tc-002",
		Status:     "completed",
		RawOutput:  map[string]string{"result": "ok"},
	})
	upd := getUpdate(t, fr)
	if upd["sessionUpdate"] != "tool_call_update" {
		t.Fatalf("sessionUpdate=%v", upd["sessionUpdate"])
	}
	if upd["toolCallId"] != "tc-002" {
		t.Fatalf("toolCallId=%v", upd["toolCallId"])
	}
	if upd["status"] != "completed" {
		t.Fatalf("status=%v", upd["status"])
	}
	ro, ok := upd["rawOutput"].(map[string]any)
	if !ok || ro["result"] != "ok" {
		t.Fatalf("rawOutput=%v", upd["rawOutput"])
	}
}

// ===================== Plan =====================

func TestPlan(t *testing.T) {
	b := newBuilder()
	entries := []PlanEntry{
		{Content: "写测试", Status: "completed"},
		{Content: "跑测试", Status: "in_progress"},
		{Content: "发布", Status: "pending"},
	}
	fr := b.Plan(entries)
	upd := getUpdate(t, fr)
	if upd["sessionUpdate"] != "plan" {
		t.Fatalf("sessionUpdate=%v", upd["sessionUpdate"])
	}
	raw, _ := json.Marshal(upd["entries"])
	var got []PlanEntry
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("entries len=%d", len(got))
	}
	if got[0].Content != "写测试" || got[0].Status != "completed" {
		t.Fatalf("entry[0]=%+v", got[0])
	}
	if got[1].Content != "跑测试" || got[1].Status != "in_progress" {
		t.Fatalf("entry[1]=%+v", got[1])
	}
	if got[2].Content != "发布" || got[2].Status != "pending" {
		t.Fatalf("entry[2]=%+v", got[2])
	}
}

// ===================== Usage / LLMRetry / CompactStatus =====================

func TestUsage(t *testing.T) {
	b := newBuilder()
	fr := b.Usage(100, 42)
	upd := getUpdate(t, fr)
	if upd["sessionUpdate"] != "usage_update" {
		t.Fatalf("sessionUpdate=%v", upd["sessionUpdate"])
	}
	if sz, _ := upd["size"].(float64); sz != 100 {
		t.Fatalf("size=%v", upd["size"])
	}
	if used, _ := upd["used"].(float64); used != 42 {
		t.Fatalf("used=%v", upd["used"])
	}
}

func TestLLMRetry(t *testing.T) {
	b := newBuilder()
	fr := b.LLMRetry(3, "rate limit")
	upd := getUpdate(t, fr)
	if upd["sessionUpdate"] != "llm_call_retry" {
		t.Fatalf("sessionUpdate=%v", upd["sessionUpdate"])
	}
	if attempt, _ := upd["attempt"].(float64); attempt != 3 {
		t.Fatalf("attempt=%v", upd["attempt"])
	}
	if upd["message"] != "rate limit" {
		t.Fatalf("message=%v", upd["message"])
	}
}

func TestCompactStatus(t *testing.T) {
	b := newBuilder()
	fr := b.CompactStatus("started")
	upd := getUpdate(t, fr)
	if upd["sessionUpdate"] != "compact_status" {
		t.Fatalf("sessionUpdate=%v", upd["sessionUpdate"])
	}
	if upd["status"] != "started" {
		t.Fatalf("status=%v", upd["status"])
	}
}

// ===================== TaskStarted / TaskEnded / TaskError / UserInput =====================

func TestTaskStarted(t *testing.T) {
	b := newBuilder()
	fr := b.TaskStarted()
	if fr.Type != TypeTaskStarted {
		t.Fatalf("type=%s", fr.Type)
	}
	if fr.Kind != "" {
		t.Fatalf("kind=%s", fr.Kind)
	}
	if len(fr.Data) != 0 {
		t.Fatalf("data 应为空")
	}
}

func TestTaskEnded(t *testing.T) {
	b := newBuilder()
	fr := b.TaskEnded()
	if fr.Type != TypeTaskEnded {
		t.Fatalf("type=%s", fr.Type)
	}
	if len(fr.Data) != 0 {
		t.Fatalf("data 应为空")
	}
}

func TestTaskError(t *testing.T) {
	b := newBuilder()
	fr := b.TaskError("something broke")
	if fr.Type != TypeTaskError {
		t.Fatalf("type=%s", fr.Type)
	}
	var m map[string]string
	if err := json.Unmarshal(fr.Data, &m); err != nil {
		t.Fatal(err)
	}
	if m["error"] != "something broke" {
		t.Fatalf("error=%v", m["error"])
	}
}

func TestUserInput(t *testing.T) {
	b := newBuilder()
	fr := b.UserInput("帮我写代码")
	if fr.Type != TypeUserInput {
		t.Fatalf("type=%s", fr.Type)
	}
	var m map[string]any
	if err := json.Unmarshal(fr.Data, &m); err != nil {
		t.Fatal(err)
	}
	// content 是 []byte,被 json.Marshal 编码为 base64
	raw, ok := m["content"].(string)
	if !ok {
		t.Fatalf("content 不是 string: %T", m["content"])
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		t.Fatalf("content 解码 base64 失败: %v", err)
	}
	if string(decoded) != "帮我写代码" {
		t.Fatalf("content=%q", string(decoded))
	}
}

// ===================== MultiEmitter =====================

func TestMultiEmitterBroadcast(t *testing.T) {
	var mu sync.Mutex
	var received []Frame

	e1 := EmitterFunc(func(fr Frame) {
		mu.Lock()
		defer mu.Unlock()
		received = append(received, fr)
	})
	e2 := EmitterFunc(func(fr Frame) {
		mu.Lock()
		defer mu.Unlock()
		received = append(received, fr)
	})

	me := MultiEmitter{e1, e2}
	b := newBuilder()
	fr := b.AgentText("broadcast")
	me.Emit(fr)

	if len(received) != 2 {
		t.Fatalf("want 2 emits, got %d", len(received))
	}
	if received[0].Seq != fr.Seq || received[1].Seq != fr.Seq {
		t.Fatal("emitted frames differ from original")
	}
}

func TestMultiEmitterEmpty(t *testing.T) {
	var me MultiEmitter
	b := newBuilder()
	// 空 MultiEmitter 不应 panic
	me.Emit(b.AgentText("x"))
}

func TestEmitterFunc(t *testing.T) {
	var got Frame
	ef := EmitterFunc(func(fr Frame) { got = fr })
	b := newBuilder()
	fr := b.AgentText("func test")
	ef.Emit(fr)
	if got.Seq != fr.Seq {
		t.Fatal("EmitterFunc 未正确传递 Frame")
	}
}

// ===================== Frame JSON 序列化/反序列化 =====================

func TestFrameJSONMarshal(t *testing.T) {
	b := newBuilder()
	fr := b.AgentText("hello")

	j, err := json.Marshal(fr)
	if err != nil {
		t.Fatal(err)
	}

	var raw map[string]any
	if err := json.Unmarshal(j, &raw); err != nil {
		t.Fatal(err)
	}

	// type 字段
	if raw["type"] != string(TypeTaskRunning) {
		t.Fatalf("type=%v", raw["type"])
	}
	// kind 字段
	if raw["kind"] != KindACPEvent {
		t.Fatalf("kind=%v", raw["kind"])
	}
	// seq
	if seq, ok := raw["seq"].(float64); !ok || seq < 1 {
		t.Fatalf("seq=%v", raw["seq"])
	}
	// timestamp
	if ts, ok := raw["timestamp"].(float64); !ok || ts == 0 {
		t.Fatalf("timestamp=%v", raw["timestamp"])
	}

	// data 应为 base64 字符串
	dataStr, ok := raw["data"].(string)
	if !ok {
		t.Fatalf("data 不是 string: %T", raw["data"])
	}
	decoded, err := base64.StdEncoding.DecodeString(dataStr)
	if err != nil {
		t.Fatalf("data 不是合法 base64: %v", err)
	}

	// 解码后应与原始 Data 一致
	if string(decoded) != string(fr.Data) {
		t.Fatalf("data base64 解码与原始 Data 不一致:\nencoded=%q\ndecoded=%q\noriginal=%q",
			dataStr, string(decoded), string(fr.Data))
	}
}

func TestFrameJSONRoundTrip(t *testing.T) {
	b := newBuilder()
	fr := b.ToolCall(ToolCallUpdate{
		ToolCallID: "rt-001",
		Title:      "bash",
		Status:     "pending",
	})

	j, err := json.Marshal(fr)
	if err != nil {
		t.Fatal(err)
	}

	var fr2 Frame
	if err := json.Unmarshal(j, &fr2); err != nil {
		t.Fatal(err)
	}

	if fr2.Type != fr.Type {
		t.Fatalf("type: %s != %s", fr2.Type, fr.Type)
	}
	if fr2.Kind != fr.Kind {
		t.Fatalf("kind: %s != %s", fr2.Kind, fr2.Kind)
	}
	if fr2.Seq != fr.Seq {
		t.Fatalf("seq: %d != %d", fr2.Seq, fr.Seq)
	}
	if fr2.Timestamp != fr.Timestamp {
		t.Fatalf("timestamp: %d != %d", fr2.Timestamp, fr.Timestamp)
	}
	if string(fr2.Data) != string(fr.Data) {
		t.Fatalf("data: %s != %s", string(fr2.Data), string(fr.Data))
	}

	// 反序列化后 data payload 可正确解析
	upd := getUpdate(t, fr2)
	if upd["sessionUpdate"] != "tool_call" || upd["toolCallId"] != "rt-001" {
		t.Fatalf("round-trip 后 update 不正确: %v", upd)
	}
}

func TestFrameJSONRoundTripPlan(t *testing.T) {
	b := newBuilder()
	fr := b.Plan([]PlanEntry{
		{Content: "step1", Status: "completed"},
		{Content: "step2", Status: "in_progress"},
	})

	j, err := json.Marshal(fr)
	if err != nil {
		t.Fatal(err)
	}

	var fr2 Frame
	if err := json.Unmarshal(j, &fr2); err != nil {
		t.Fatal(err)
	}

	upd := getUpdate(t, fr2)
	if upd["sessionUpdate"] != "plan" {
		t.Fatalf("sessionUpdate=%v", upd["sessionUpdate"])
	}
	raw, _ := json.Marshal(upd["entries"])
	var got []PlanEntry
	json.Unmarshal(raw, &got)
	if len(got) != 2 || got[0].Content != "step1" {
		t.Fatalf("entries=%+v", got)
	}
}

func TestFrameJSONOmitEmpty(t *testing.T) {
	// kind/data 空时 omitempty
	b := newBuilder()
	fr := b.TaskStarted()
	j, err := json.Marshal(fr)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	json.Unmarshal(j, &raw)
	// kind 应为空且不应出现在 JSON 中
	if _, exists := raw["kind"]; exists {
		t.Fatalf("kind 不应出现: %v", raw["kind"])
	}
	// data 应为空且不应出现
	if _, exists := raw["data"]; exists {
		t.Fatalf("data 不应出现: %v", raw["data"])
	}
	// 但 type/timestamp/seq 必须存在
	if raw["type"] != string(TypeTaskStarted) {
		t.Fatalf("type=%v", raw["type"])
	}
	if _, exists := raw["timestamp"]; !exists {
		t.Fatal("timestamp 缺失")
	}
	if _, exists := raw["seq"]; !exists {
		t.Fatal("seq 缺失")
	}
}
