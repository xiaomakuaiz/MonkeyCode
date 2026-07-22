// 子代理路由:上游转发的子循环事件的认领/物化/预览/关闭(ohmy.rs 拆出)。
//
// 职责:claim_subagent(经事件戳记的 parent_session_id/parent_tool_call_id
// 精确认领并物化为壳侧子会话)、subagent_feed(父卡进度窗内联预览)、
// close_*(工具闭合/轮次收尾时冲洗行缓冲并关闭子会话)。
// 共享状态定义见 ohmy.rs::Inner。

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use serde_json::{json, Value};

use super::frame::{self, SessionStatus};
use super::normalize::perm_title;
use super::ohmy::Inner;
use super::session::SessionState;

pub(super) struct SubagentRoute {
    pub(super) parent_sid: String,
    pub(super) parent_tc: String,
    /// model_delta 行缓冲:凑整行再出 subagent_text(防每 token 一帧)
    pub(super) line_buf: String,
}

/// 子代理态锁组:子会话路由与 Agent 工具入参/结果暂存。
/// 含锁:subagents、agent_results、agent_inputs(均 StdMutex)。
/// 加锁秩序(评审梳理,不得反向):subagents → sessions(SessionsState;
/// reconcile_all/active_workdir 持 subagents 期间读 sessions 表,
/// 反向嵌套禁止);agent_results/agent_inputs 点状取放,不与其他锁嵌套。
pub(super) struct SubagentState {
    /// 子代理事件路由(child_sid → 父会话/父 Agent 工具)。上游把子循环事件
    /// 原样转发,session_id 是子循环的随机 id,归属经事件戳记的
    /// parent_session_id/parent_tool_call_id 精确认领(dab1b85);
    /// 无戳记的事件不认领(旧猜测启发式已删,见 claim_subagent)
    pub(super) subagents: StdMutex<HashMap<String, SubagentRoute>>,
    /// 同步子代理全量结果暂存(tool_call_id → (status, content)):引擎先发
    /// agent_result(全量、不截断)再回 tool_result(截断 500 字符,可能把
    /// 结果 JSON 截成半截,subagent.go deliverSyncResult),闭合工具卡时
    /// 以暂存内容为权威(structuredToolResult cap)
    pub(super) agent_results: StdMutex<HashMap<String, (String, String)>>,
    /// 父会话 Agent 工具入参暂存(tc_id → (description, prompt)),
    /// 子会话物化时作标题与首条输入
    pub(super) agent_inputs: StdMutex<HashMap<String, (String, String)>>,
}

impl Inner {
    /// 子代理认领 + 物化。上游 dab1b85 起事件自带 parent_session_id/
    /// parent_tool_call_id,精确认领;无戳记的事件**不认领**(旧的"运行中
    /// 且持有未闭合 Agent 工具的会话"猜测启发式已删——并发多 Agent 时会
    /// 把事件挂错父卡,而桌面与引擎同包分发且 protocolVersion 已校验,
    /// 启发式只服务开发期版本偏斜,记日志丢弃比认错安全)。物化为
    /// **壳侧子会话**(sidecar 带 parent,可回放可跟流)——父卡 feed 预览
    /// + child_session 链接点开完整对话。认领不到(迟到/无戳记)返回 false。
    pub(super) fn claim_subagent(&self, child_sid: &str, event: &Value) -> bool {
        if self.sub.subagents.lock().unwrap().contains_key(child_sid) {
            return true;
        }
        // 事件自带父归属:父 sid 经 shell_sid_of 反查(engine_id 换绑兼容)
        let stamped = event
            .get("parent_session_id")
            .and_then(|v| v.as_str())
            .filter(|p| !p.is_empty())
            .map(|p| {
                let psid = self.shell_sid_of(p);
                let ptc = event
                    .get("parent_tool_call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                (psid, ptc)
            });
        let claimed = match stamped {
            Some((psid, ptc)) => {
                let sessions = self.sess.sessions.lock().unwrap();
                sessions.get(&psid).map(|s| {
                    // 父工具 id 缺省时兜底找未闭合 Agent 工具
                    let ptc = if !ptc.is_empty() {
                        ptc
                    } else {
                        s.open_tools
                            .iter()
                            .find(|(_, n)| n.as_str() == "Agent")
                            .map(|(tc, _)| tc.clone())
                            .unwrap_or_default()
                    };
                    (psid.clone(), ptc, s.workdir.clone(), s.model_name.clone())
                })
            }
            None => {
                // 无 parent_session_id 戳记:不猜测认领(见函数注释),
                // 记日志外显后丢弃——同包分发下走到这里即引擎侧异常
                eprintln!(
                    "[desktop] 子代理事件缺 parent_session_id,不认领: sid={child_sid} type={}",
                    event.get("type").and_then(|v| v.as_str()).unwrap_or("?")
                );
                None
            }
        };
        let Some((psid, ptc, workdir, model_name)) = claimed else { return false };
        let (mut title, prompt) = self
            .sub.agent_inputs
            .lock()
            .unwrap()
            .get(&ptc)
            .cloned()
            .unwrap_or_else(|| ("子代理".into(), String::new()));
        // 事件戳的 parent_description 优先(939e03e):后台代理跨轮续跑时
        // tc_id 暂存可能已清,戳记恒在
        if let Some(d) = event.get("parent_description").and_then(|v| v.as_str()).filter(|d| !d.is_empty()) {
            title = d.to_string();
        }
        self.sess.sessions.lock().unwrap().insert(
            child_sid.to_string(),
            SessionState {
                seq: 0,
                running: true,
                created: true, // 壳侧会话,无引擎实体,open 不做 resume RPC
                engine_id: child_sid.to_string(),
                opened: false,
                open_tools: HashMap::new(),
                model_text: String::new(),
                last_event_seq: 0,
                workdir: workdir.clone(),
                model_name: model_name.clone(),
                mode: "default".into(),
                title: title.clone(),
            },
        );
        self.write_sidecar(child_sid, |m| {
            m["parent"] = json!(psid);
            m["workdir"] = json!(workdir);
            m["model_name"] = json!(model_name);
            m["title"] = json!(title);
            m["status"] = json!(SessionStatus::Running.as_str());
        });
        self.sub.subagents.lock().unwrap().insert(
            child_sid.to_string(),
            SubagentRoute { parent_sid: psid.clone(), parent_tc: ptc.clone(), line_buf: String::new() },
        );
        // 子会话回放形状与主会话一致:user-input(任务)→ task-started → …
        if !prompt.is_empty() {
            self.push_frame(child_sid, |seq| frame::user_input(&prompt, seq));
        }
        self.push_frame(child_sid, frame::task_started);
        // 父卡挂子会话链接(UI 点开完整视图)
        self.push_frame(&psid, |seq| {
            frame::tool_call_progress(
                &ptc,
                json!({ "kind": "child_session", "childSessionId": child_sid }),
                seq,
            )
        });
        true
    }

    /// 子代理事件在父卡进度窗的内联预览(完整对话在子会话本体)。
    pub(super) fn subagent_feed(&self, child_sid: &str, etype: &str, event: &Value, data: &Value) {
        let Some((psid, ptc)) = self
            .sub.subagents
            .lock()
            .unwrap()
            .get(child_sid)
            .map(|r| (r.parent_sid.clone(), r.parent_tc.clone()))
        else {
            return;
        };
        match etype {
            "tool_call" => {
                let tc_id = event
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .or_else(|| data.get("id").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string();
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("工具");
                let input = data.get("input").cloned().unwrap_or(Value::Null);
                let title = perm_title(name, &input);
                self.push_frame(&psid, |seq| {
                    frame::tool_call_progress(
                        &ptc,
                        json!({ "kind": "subagent_tool", "id": tc_id, "title": title, "status": "run" }),
                        seq,
                    )
                });
            }
            "tool_result" => {
                let tc_id = event.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                self.push_frame(&psid, |seq| {
                    frame::tool_call_progress(
                        &ptc,
                        json!({ "kind": "subagent_tool", "id": tc_id, "status": "ok" }),
                        seq,
                    )
                });
            }
            "model_delta" => {
                let text = data.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let lines = {
                    let mut subs = self.sub.subagents.lock().unwrap();
                    let Some(r) = subs.get_mut(child_sid) else { return };
                    r.line_buf.push_str(text);
                    let mut out = Vec::new();
                    while let Some(pos) = r.line_buf.find('\n') {
                        let line: String = r.line_buf.drain(..=pos).collect();
                        let line = line.trim_end().to_string();
                        if !line.is_empty() {
                            out.push(line);
                        }
                    }
                    out
                };
                for line in lines {
                    self.push_frame(&psid, |seq| {
                        frame::tool_call_progress(&ptc, json!({ "kind": "subagent_text", "line": line }), seq)
                    });
                }
            }
            "error" => {
                let msg = data.get("error").and_then(|v| v.as_str()).unwrap_or("子代理出错");
                self.push_frame(&psid, |seq| {
                    frame::tool_call_progress(
                        &ptc,
                        json!({ "kind": "subagent_text", "line": format!("✗ {msg}") }),
                        seq,
                    )
                });
            }
            // thinking_delta/model_done:进度窗不展示思考流与轮界
            _ => {}
        }
    }

    /// 关闭一个子会话:收尾帧 + sidecar 终态(不发 session-event,不惊动侧栏)。
    fn close_child(&self, child_sid: &str, status: SessionStatus) {
        let was = {
            let mut sessions = self.sess.sessions.lock().unwrap();
            match sessions.get_mut(child_sid) {
                Some(s) if s.running => {
                    s.running = false;
                    true
                }
                _ => false,
            }
        };
        if !was {
            return;
        }
        self.push_frame(child_sid, frame::task_ended);
        self.write_sidecar(child_sid, |m| m["status"] = json!(status.as_str()));
    }

    /// 父会话某工具闭合:冲洗子代理残留行缓冲、关闭对应子会话、删路由。
    pub(super) fn close_subagents_of(&self, sid: &str, tc_id: &str) {
        let closing: Vec<(String, String)> = {
            let mut subs = self.sub.subagents.lock().unwrap();
            let closing = subs
                .iter_mut()
                .filter(|(_, r)| r.parent_sid == sid && r.parent_tc == tc_id)
                .map(|(child, r)| (child.clone(), std::mem::take(&mut r.line_buf).trim().to_string()))
                .collect();
            subs.retain(|_, r| !(r.parent_sid == sid && r.parent_tc == tc_id));
            closing
        };
        for (child, tail) in closing {
            if !tail.is_empty() {
                self.push_frame(sid, |seq| {
                    frame::tool_call_progress(tc_id, json!({ "kind": "subagent_text", "line": tail }), seq)
                });
            }
            self.close_child(&child, SessionStatus::Finished);
        }
        self.sub.agent_inputs.lock().unwrap().remove(tc_id);
    }

    /// 会话轮次结束/和解:其子代理路由全部失效,残留子会话按 status 收尾。
    pub(super) fn close_children_of_session(&self, sid: &str, status: SessionStatus) {
        let children: Vec<String> = {
            let mut subs = self.sub.subagents.lock().unwrap();
            let children = subs
                .iter()
                .filter(|(_, r)| r.parent_sid == sid)
                .map(|(child, _)| child.clone())
                .collect();
            subs.retain(|_, r| r.parent_sid != sid);
            children
        };
        for child in children {
            self.close_child(&child, status);
        }
    }
}
