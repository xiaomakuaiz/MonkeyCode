// Frame 词汇的唯一定义(产帧权威;词汇源自 mc-agent 时代的 frame.go,
// 其 Go 版随单引擎化删除,git 历史可查)。
//
// 对表:本模块产帧、UI 消费(mc-desktop/ui/src/{types.ts,reduce.ts})——
// 任何新帧类型/字段先改这里与 types.ts,driver 禁止手拼 Frame JSON。
//
// 帧结构:{ type, kind?, data?(base64 JSON), timestamp(ms), seq }
// task-running + acp_event 的 data 为 { update: { sessionUpdate, ... } }。

use base64::Engine as _;
use serde_json::{json, Value};

/// 会话状态词汇(SessionMeta.status;UI/桌宠按此渲染,勿用裸字符串)。
/// 对表 mc-desktop/ui/src/types.ts 的 SessionStatus。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SessionStatus {
    Created,
    Running,
    Finished,
    Interrupted,
    Error,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Created => "created",
            SessionStatus::Running => "running",
            SessionStatus::Finished => "finished",
            SessionStatus::Interrupted => "interrupted",
            SessionStatus::Error => "error",
        }
    }
}

/// 审批终态词汇(permission-resolved.outcome)。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PermOutcome {
    Approved,
    Denied,
    Timeout,
    Cancelled,
}

impl PermOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            PermOutcome::Approved => "approved",
            PermOutcome::Denied => "denied",
            PermOutcome::Timeout => "timeout",
            PermOutcome::Cancelled => "cancelled",
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// data 字段编码:JSON → base64(与 Go 侧 []byte 的 JSON 序列化一致)。
pub fn b64_json(v: &Value) -> String {
    base64::engine::general_purpose::STANDARD.encode(v.to_string())
}

pub fn b64_text(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s)
}

#[allow(dead_code)] // 测试与回放工具使用
pub fn b64_decode_json(s: &str) -> Option<Value> {
    let raw = base64::engine::general_purpose::STANDARD.decode(s).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn build(ftype: &str, kind: Option<&str>, payload: Option<Value>, seq: u64) -> Value {
    let mut f = json!({ "type": ftype, "timestamp": now_ms(), "seq": seq });
    if let Some(k) = kind {
        f["kind"] = json!(k);
    }
    if let Some(p) = payload {
        f["data"] = json!(b64_json(&p));
    }
    f
}

fn acp(update: Value, seq: u64) -> Value {
    build("task-running", Some("acp_event"), Some(json!({ "update": update })), seq)
}

// ==================== 顶层帧 ====================

pub fn task_started(seq: u64) -> Value {
    build("task-started", None, None, seq)
}

pub fn task_ended(seq: u64) -> Value {
    build("task-ended", None, None, seq)
}

pub fn task_error(msg: &str, seq: u64) -> Value {
    build("task-error", None, Some(json!({ "error": msg })), seq)
}

/// 用户输入回显(content 为 base64 文本,与云端上行格式一致)。
pub fn user_input(text: &str, seq: u64) -> Value {
    build("user-input", None, Some(json!({ "content": b64_text(text) })), seq)
}

pub fn permission_req(id: &str, tool: &str, title: &str, seq: u64) -> Value {
    build("permission-req", None, Some(json!({ "id": id, "tool": tool, "title": title })), seq)
}

pub fn permission_resolved(id: &str, outcome: PermOutcome, seq: u64) -> Value {
    build("permission-resolved", None, Some(json!({ "id": id, "outcome": outcome.as_str() })), seq)
}

/// 提问卡答复回显(回放可见答案;request_id 即 askId)。
pub fn reply_question(request_id: &str, answers_json: &str, cancelled: bool, seq: u64) -> Value {
    build(
        "reply-question",
        None,
        Some(json!({ "request_id": request_id, "answers_json": answers_json, "cancelled": cancelled })),
        seq,
    )
}

/// AI 提问卡(kind=acp_ask_user_question 即一等公民标记,reduce.ts 直接消费
/// toolCall.rawInput.questions,不走 tool_call 的标题启发式)。
pub fn ask_user_question(request_id: &str, questions: &Value, seq: u64) -> Value {
    build(
        "task-running",
        Some("acp_ask_user_question"),
        Some(json!({ "toolCall": {
            "toolCallId": request_id,
            "title": "Ask User Question",
            "kind": "ask-user-question",
            "status": "in_progress",
            "rawInput": { "questions": questions },
        } })),
        seq,
    )
}

// ==================== ACP session update 帧 ====================

pub fn agent_text(delta: &str, seq: u64) -> Value {
    acp(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": delta } }), seq)
}

pub fn agent_thought(delta: &str, seq: u64) -> Value {
    acp(json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": delta } }), seq)
}

pub fn tool_call(tc_id: &str, title: &str, raw_input: &Value, seq: u64) -> Value {
    acp(
        json!({ "sessionUpdate": "tool_call", "toolCallId": tc_id, "title": title,
            "status": "in_progress", "rawInput": raw_input }),
        seq,
    )
}

pub fn tool_call_completed(tc_id: &str, raw_output: &str, seq: u64) -> Value {
    acp(
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": tc_id,
            "status": "completed", "rawOutput": raw_output }),
        seq,
    )
}

/// 工具执行期进度(status=in_progress + progress 载荷;词汇见 types.ts
/// ToolProgress:subagent_tool/subagent_text/output/child_session)。
/// 子代理活动即经此挂到父会话 Agent 工具卡的进度窗。
pub fn tool_call_progress(tc_id: &str, progress: Value, seq: u64) -> Value {
    acp(
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": tc_id,
            "status": "in_progress", "progress": progress }),
        seq,
    )
}

/// 工具失败/中断收尾。ohmyagent 的工具错误路径不发 tool_result 事件
/// (错误只进模型消息),由驱动在轮次结束时对未闭合的 tool_call 补此帧,
/// 否则 UI 工具卡永远转圈。
pub fn tool_call_failed(tc_id: &str, raw_output: &str, seq: u64) -> Value {
    acp(
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": tc_id,
            "status": "failed", "rawOutput": raw_output }),
        seq,
    )
}

/// 上下文用量(环形指示):used = 最近一次模型调用的 prompt 侧 token
/// (input + cache 写/读),size = 模型上下文预算。
pub fn usage_update(used: i64, size: i64, seq: u64) -> Value {
    acp(json!({ "sessionUpdate": "usage_update", "used": used, "size": size }), seq)
}

pub fn compact_status(status: &str, seq: u64) -> Value {
    acp(json!({ "sessionUpdate": "compact_status", "status": status }), seq)
}

pub fn model_update(model: &str, seq: u64) -> Value {
    acp(json!({ "sessionUpdate": "model_update", "model": model }), seq)
}

pub fn permission_mode_update(mode: &str, seq: u64) -> Value {
    acp(json!({ "sessionUpdate": "permission_mode_update", "mode": mode }), seq)
}
