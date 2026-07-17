// Package frame 定义内核对外的流式帧协议。
//
// 帧结构与云端任务流一致(backend/consts/task.go 与 mobile/src/messages/handler.ts):
//
//	{ "type": <TaskStreamType>, "kind": <Kind>, "data": <base64 JSON>, "timestamp": <ms>, "seq": <uint64> }
//
// task-running/task-event 帧的 data 为 ACP 风格 session update:
//
//	{ "update": { "sessionUpdate": "agent_message_chunk", ... } }
package frame

import (
	"encoding/json"
	"sync/atomic"
	"time"
)

// Type 帧类型,对齐 backend/consts/task.go 的 TaskStreamType 以及
// 日志流中的 task-started/task-ended/task-error 事件。
type Type string

const (
	TypePing        Type = "ping"
	TypeError       Type = "error"
	TypeTaskStarted Type = "task-started"
	TypeTaskRunning Type = "task-running"
	TypeTaskEnded   Type = "task-ended"
	TypeTaskError   Type = "task-error"
	TypeUserInput   Type = "user-input"
	TypeUserCancel  Type = "user-cancel"

	// 本地宿主的权限审批透传(云端对应 auto-approve/permission-resp 机制)
	TypePermissionReq  Type = "permission-req"
	TypePermissionResp Type = "permission-resp"
	// PermissionResolved 审批终态广播:answered/timeout/cancelled,
	// UI 据此关闭卡片;落日志使回放中的历史卡片呈现真实状态。
	TypePermissionResolved Type = "permission-resolved"

	// call/call-response:UI 的同步只读查询(文件树/读文件/变更/diff),
	// 不进事件日志(与任务流无关,回放时不重放)。
	TypeCall         Type = "call"
	TypeCallResponse Type = "call-response"
)

// call kind:文件浏览与 diff 查询,以及会话级操作。
const (
	KindRepoFileList    = "repo_file_list"
	KindRepoReadFile    = "repo_read_file"
	KindRepoFileChanges = "repo_file_changes"
	KindRepoFileDiff    = "repo_file_diff"
	KindRepoReveal      = "repo_reveal"
	// KindSessionSetModel 切换会话模型(轮次间生效;执行中拒绝)。
	// 成功后另发 model_update 帧进事件日志,回放可见。
	KindSessionSetModel = "session_set_model"
	// KindSessionSetMode 切换会话权限模式(default/yolo)。与 set_model 不同,
	// 执行中也可切换;成功后另发 permission_mode_update 帧进事件日志。
	KindSessionSetMode = "session_set_mode"
)

// Kind 帧内容子类型。
const (
	KindACPEvent        = "acp_event"
	KindAskUserQuestion = "acp_ask_user_question"
)

// Frame 单条流式帧。Data 在 JSON 中编码为 base64(与云端一致)。
type Frame struct {
	Type      Type   `json:"type"`
	Kind      string `json:"kind,omitempty"`
	Data      []byte `json:"data,omitempty"`
	Timestamp int64  `json:"timestamp"`
	Seq       uint64 `json:"seq"`
}

// Emitter 帧消费方(终端渲染器、会话日志、未来的 WS 宿主)。
type Emitter interface {
	Emit(Frame)
}

// EmitterFunc 函数式 Emitter。
type EmitterFunc func(Frame)

func (f EmitterFunc) Emit(fr Frame) { f(fr) }

// MultiEmitter 广播到多个 Emitter。
type MultiEmitter []Emitter

func (m MultiEmitter) Emit(fr Frame) {
	for _, e := range m {
		e.Emit(fr)
	}
}

// Builder 负责给帧编 seq 和时间戳。
type Builder struct {
	seq atomic.Uint64
}

// SetSeq 设置起始序号(恢复历史会话时衔接既有事件日志)。
func (b *Builder) SetSeq(n uint64) { b.seq.Store(n) }

func (b *Builder) build(t Type, kind string, payload any) Frame {
	var data []byte
	if payload != nil {
		data, _ = json.Marshal(payload)
	}
	return Frame{
		Type:      t,
		Kind:      kind,
		Data:      data,
		Timestamp: time.Now().UnixMilli(),
		Seq:       b.seq.Add(1),
	}
}

// ==================== ACP session update 载荷 ====================

// acpEnvelope task-running + acp_event 帧的 data 结构。
type acpEnvelope struct {
	Update any `json:"update"`
}

// ContentBlock ACP 内容块(目前仅 text)。
type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// PlanEntry 计划条目。status: pending | in_progress | completed。
type PlanEntry struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

// ToolCallUpdate tool_call / tool_call_update 载荷。
// Status: pending | in_progress | completed | failed。
// Progress 为执行期进度(status=in_progress 时携带,见 tools.ProgressUpdate),
// 未知字段会被旧客户端忽略,协议向后兼容。
type ToolCallUpdate struct {
	SessionUpdate string `json:"sessionUpdate"`
	ToolCallID    string `json:"toolCallId"`
	Title         string `json:"title,omitempty"`
	Kind          string `json:"kind,omitempty"`
	Status        string `json:"status,omitempty"`
	RawInput      any    `json:"rawInput,omitempty"`
	RawOutput     any    `json:"rawOutput,omitempty"`
	Progress      any    `json:"progress,omitempty"`
}

type messageChunk struct {
	SessionUpdate string       `json:"sessionUpdate"`
	Content       ContentBlock `json:"content"`
}

type planUpdate struct {
	SessionUpdate string      `json:"sessionUpdate"`
	Entries       []PlanEntry `json:"entries"`
}

type usageUpdate struct {
	SessionUpdate string `json:"sessionUpdate"`
	Size          int    `json:"size"`
	Used          int    `json:"used"`
}

type llmCallRetry struct {
	SessionUpdate string `json:"sessionUpdate"`
	Attempt       int    `json:"attempt"`
	Message       string `json:"message"`
}

type compactStatus struct {
	SessionUpdate string `json:"sessionUpdate"`
	Status        string `json:"status"`
}

// ==================== 构造函数 ====================

func (b *Builder) TaskStarted() Frame { return b.build(TypeTaskStarted, "", nil) }
func (b *Builder) TaskEnded() Frame   { return b.build(TypeTaskEnded, "", nil) }

func (b *Builder) TaskError(msg string) Frame {
	return b.build(TypeTaskError, "", map[string]string{"error": msg})
}

// UserInput 用户输入帧(与云端上行格式一致:content 为 base64 文本)。
func (b *Builder) UserInput(text string) Frame {
	payload := map[string]any{"content": []byte(text)}
	return b.build(TypeUserInput, "", payload)
}

// PermissionReq 权限审批请求(等待客户端回 permission-resp)。
func (b *Builder) PermissionReq(id, tool, title string) Frame {
	return b.build(TypePermissionReq, "", map[string]string{
		"id": id, "tool": tool, "title": title,
	})
}

// PermissionResolved 审批终态。outcome: approved | denied | timeout | cancelled。
func (b *Builder) PermissionResolved(id, outcome string) Frame {
	return b.build(TypePermissionResolved, "", map[string]string{
		"id": id, "outcome": outcome,
	})
}

func (b *Builder) acp(update any) Frame {
	return b.build(TypeTaskRunning, KindACPEvent, acpEnvelope{Update: update})
}

// AgentText agent 正文增量。
func (b *Builder) AgentText(delta string) Frame {
	return b.acp(messageChunk{
		SessionUpdate: "agent_message_chunk",
		Content:       ContentBlock{Type: "text", Text: delta},
	})
}

// AgentThought 思考增量。
func (b *Builder) AgentThought(delta string) Frame {
	return b.acp(messageChunk{
		SessionUpdate: "agent_thought_chunk",
		Content:       ContentBlock{Type: "text", Text: delta},
	})
}

// ToolCall 工具调用开始。
func (b *Builder) ToolCall(u ToolCallUpdate) Frame {
	u.SessionUpdate = "tool_call"
	return b.acp(u)
}

// ToolCallUpdate 工具调用状态/结果更新。
func (b *Builder) ToolCallUpdate(u ToolCallUpdate) Frame {
	u.SessionUpdate = "tool_call_update"
	return b.acp(u)
}

// Plan 计划(todo)全量更新。
func (b *Builder) Plan(entries []PlanEntry) Frame {
	return b.acp(planUpdate{SessionUpdate: "plan", Entries: entries})
}

// Usage 上下文用量更新。
func (b *Builder) Usage(size, used int) Frame {
	return b.acp(usageUpdate{SessionUpdate: "usage_update", Size: size, Used: used})
}

// LLMRetry 模型调用重试提示。
func (b *Builder) LLMRetry(attempt int, msg string) Frame {
	return b.acp(llmCallRetry{SessionUpdate: "llm_call_retry", Attempt: attempt, Message: msg})
}

// CompactStatus 上下文压缩状态。status: started | ended。
func (b *Builder) CompactStatus(status string) Frame {
	return b.acp(compactStatus{SessionUpdate: "compact_status", Status: status})
}

type modelUpdate struct {
	SessionUpdate string `json:"sessionUpdate"`
	Model         string `json:"model"`
}

// ModelUpdate 会话模型切换(model 为展示名)。
func (b *Builder) ModelUpdate(model string) Frame {
	return b.acp(modelUpdate{SessionUpdate: "model_update", Model: model})
}

type permissionModeUpdate struct {
	SessionUpdate string `json:"sessionUpdate"`
	Mode          string `json:"mode"` // default | yolo
}

// PermissionModeUpdate 会话权限模式切换广播。
func (b *Builder) PermissionModeUpdate(mode string) Frame {
	return b.acp(permissionModeUpdate{SessionUpdate: "permission_mode_update", Mode: mode})
}
