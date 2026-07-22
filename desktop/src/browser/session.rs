// 浏览器会话现场(单会话):当前标签页、ref 表、事件旁白与 CDP 交互原语。
// 契约对齐 agent/internal/browser/session.go(语义逐字移植)。
//
// 与 Go 的差异(均为架构承担,非语义取舍):
//   - Go 多会话(owner/RegisterSession/事件按 tabId 路由)在桌面端收敛为
//     单会话:bridge 层只有一个事件回调(set_event_handler),tab 归属登记
//     (claim_tab/release_tab)保留以对齐扩展侧受控集合语义,本层无 owner 概念。
//   - 事件回调注册在 new() 时完成(Go 是首次工具调用时惰性注册);handoff
//     待领队列仍在工具调用入口惰性消费(ensure),消费点与 Go 一致。
//
// 对兄弟模块的 API 依赖(并行开发,以任务契约为准):
//   - bridge.rs: ExtBridge(Clone): set_event_handler(Arc<dyn Fn(Message)+Send+Sync>)
//     / claim_tab / release_tab / take_pending_handoff
//   - cdp.rs: Cdp{ bridge }(Clone): cmd(tab_id, session_id: Option<&str>, method,
//     params: Option<Value>) -> Result<Value, String>;attach/detach/tabs_*/frames_list
//   - refs.rs: RefTable(Default): gen()/object_group()/rebuild(gen, Vec<ElemRef>)
//     /lookup(&str) -> Result<ElemRef, String>/invalidate();err_ref_stale(&str) -> String

use std::collections::HashSet;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, Weak};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::bridge::ExtBridge;
use super::cdp::Cdp;
use super::protocol::{
    Message, TabInfo, ERR_MARK_DETACHED, EVENT_CDP, EVENT_DETACHED, EVENT_TAB_REMOVED,
};
use super::refs::{err_ref_stale, RefTable};

/// BrowserSession 浏览器操作现场:当前标签页、ref 表、事件旁白。
/// Clone 共享同一现场(9 个工具共用;对齐 Go 里工具内嵌 *Session)。
#[derive(Clone)]
pub struct BrowserSession(pub(crate) Arc<SessInner>);

pub(crate) struct SessInner {
    pub(crate) cdp: Cdp,
    pub(crate) st: StdMutex<SessState>,
    /// 事件回调可能在任意线程被调用;对话框自动应答需异步 CDP,借创建时
    /// 捕获的 runtime 句柄 spawn(对齐 Go 的 go func())。
    rt: Option<tokio::runtime::Handle>,
}

/// 会话可变状态(锁内小临界区,不变式:任何 .await 前必须先释放锁)。
#[derive(Default)]
pub(crate) struct SessState {
    /// 当前操作的标签页(None=无;Go 的 tabID==0)。
    pub(crate) tab_id: Option<i64>,
    /// 本会话控制的标签页集合。
    pub(crate) tabs: HashSet<i64>,
    pub(crate) refs: RefTable,
    /// 上次快照涉及的跨源 iframe 子会话(释放对象组用)。
    pub(crate) last_oopif: Vec<String>,
    /// 事件旁白,附注到下一个工具结果(上限 20 条)。
    notes: Vec<String>,
    closed: bool,
}

impl SessState {
    /// 追加事件旁白(须已持锁;上限 20 条,对齐 Go addNoteLocked)。
    pub(crate) fn add_note(&mut self, note: String) {
        if self.notes.len() < 20 {
            self.notes.push(note);
        }
    }
}

impl BrowserSession {
    /// 创建浏览器会话现场并注册事件处理器(不建立任何连接,标签页在首次
    /// 工具调用时惰性认领/新建)。
    pub fn new(bridge: ExtBridge) -> Self {
        let inner = Arc::new(SessInner {
            cdp: Cdp { bridge: bridge.clone() },
            st: StdMutex::new(SessState::default()),
            rt: tokio::runtime::Handle::try_current().ok(),
        });
        // Weak 防环:handler 持 Arc 会让会话永不释放
        let weak: Weak<SessInner> = Arc::downgrade(&inner);
        bridge.set_event_handler(Arc::new(move |msg: Message| {
            if let Some(inner) = weak.upgrade() {
                inner.handle_event(msg);
            }
        }));
        BrowserSession(inner)
    }

    pub(crate) fn state(&self) -> MutexGuard<'_, SessState> {
        self.0.st.lock().unwrap()
    }

    /// 释放会话:剥离本会话标签页的 debugger(标签页保留,用户可能还要看)。
    /// 幂等。(Go 侧还会 UnregisterSession;单会话桥无此概念)
    #[allow(dead_code)] // 退出清理钩子备用(扩展在 WS 断开后自会回收)
    pub async fn close(&self) {
        let tabs: Vec<i64> = {
            let mut st = self.state();
            if st.closed {
                return;
            }
            st.closed = true;
            st.tabs.iter().copied().collect()
        };
        for id in tabs {
            let _ = tokio::time::timeout(Duration::from_secs(3), self.0.cdp.detach(id)).await;
        }
    }

    /// 激活会话:无活动标签页时认领用户交付的标签页(待领队列惰性消费,
    /// 消费点对齐 Go 的 ensure → TakePendingHandoff)。
    pub(crate) fn ensure(&self) -> Result<(), String> {
        let (closed, no_tab) = {
            let st = self.state();
            (st.closed, st.tab_id.is_none())
        };
        if closed {
            return Err("浏览器会话已关闭".to_string());
        }
        if no_tab {
            if let Some(tab) = self.0.cdp.bridge.take_pending_handoff() {
                self.adopt_tab(&tab);
            }
        }
        Ok(())
    }

    /// 认领标签页(用户交付):登记归属,设为当前(若尚无),notes 记一条。
    fn adopt_tab(&self, t: &TabInfo) {
        self.0.cdp.bridge.claim_tab(t.tab_id);
        let mut st = self.state();
        st.tabs.insert(t.tab_id);
        if st.tab_id.is_none() {
            st.tab_id = Some(t.tab_id);
            st.refs.invalidate();
        }
        st.add_note(format!(
            "用户交付了标签页 #{}({})",
            t.tab_id,
            first_non_empty(&[&t.title, &t.url])
        ));
    }

    /// 激活会话并确保当前标签页可操作(attach 幂等自愈 + 域启用)。
    pub(crate) async fn ensure_tab(&self) -> Result<i64, String> {
        self.ensure()?;
        let tab = self.state().tab_id;
        let Some(tab) = tab else {
            return Err("当前没有活动标签页;可用 browser_navigate 打开页面,或 browser_tabs 新建/选择标签页,或引导用户经扩展交付标签页".to_string());
        };
        self.0.cdp.attach(tab).await?;
        // Page 事件(对话框/导航)只 enable 这一个 domain,事件量可控;
        // DOM enable 供 getBoxModel 取元素主视口坐标(含 iframe 偏移)
        let _ = self.0.cdp.cmd(tab, None, "Page.enable", None).await;
        let _ = self.0.cdp.cmd(tab, None, "DOM.enable", None).await;
        Ok(tab)
    }

    /// 取出并清空事件旁白(拼进工具结果)。
    pub fn take_notes(&self) -> String {
        let mut st = self.state();
        if st.notes.is_empty() {
            return String::new();
        }
        let out = format!("\n[浏览器事件] {}", st.notes.join(";"));
        st.notes.clear();
        out
    }

    // ==================== CDP 交互原语 ====================

    /// 执行一条 CDP 命令,detached 失败时自动重 attach 一次再试。
    /// (Go 靠每次 ensureTab 都 Attach 达成同等自愈;此处再加命令级兜底,
    /// 覆盖"工具执行中途被剥离"的窗口。用户主动收回的标签页已移出受控集合,
    /// 重 attach 会被扩展拒绝,不会违背用户意愿。)
    pub(crate) async fn cmd(
        &self,
        tab: i64,
        session_id: Option<&str>,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
        match self.0.cdp.cmd(tab, session_id, method, params.clone()).await {
            Err(e) if is_detached_err(&e) => {
                self.0.cdp.attach(tab).await?;
                self.0.cdp.cmd(tab, session_id, method, params).await
            }
            other => other,
        }
    }

    /// 在标签页根会话的主世界执行表达式,returnByValue 反序列化为 T。
    /// 结果无值(undefined/null)时返回 T::default()(对齐 Go 的 out 不写入)。
    pub(crate) async fn eval<T: DeserializeOwned + Default>(
        &self,
        tab: i64,
        expr: &str,
    ) -> Result<T, String> {
        self.eval_session(tab, None, expr).await
    }

    /// 在指定会话(None = 根会话;Some = OOPIF 子会话)执行表达式。
    pub(crate) async fn eval_session<T: DeserializeOwned + Default>(
        &self,
        tab: i64,
        session_id: Option<&str>,
        expr: &str,
    ) -> Result<T, String> {
        let raw = self
            .cmd(
                tab,
                session_id,
                "Runtime.evaluate",
                Some(json!({"expression": expr, "returnByValue": true})),
            )
            .await?;
        let res: EvalResult = serde_json::from_value(raw)
            .map_err(|e| format!("CDP Runtime.evaluate 结果解析失败: {e}"))?;
        res.err()?;
        match res.result.value {
            Some(v) => serde_json::from_value(v).map_err(|e| format!("页面脚本结果解析失败: {e}")),
            None => Ok(T::default()),
        }
    }

    /// 对远端元素执行函数(this 为元素),returnByValue 反序列化为 T。
    /// session_id 非空时元素在 OOPIF 子会话。执行上下文已销毁(页面导航)时
    /// 统一翻译为 ref 失效错误。
    pub(crate) async fn call_on<T: DeserializeOwned + Default>(
        &self,
        tab: i64,
        session_id: Option<&str>,
        object_id: &str,
        func: &str,
        args: &[Value],
    ) -> Result<T, String> {
        let call_args: Vec<Value> = args.iter().map(|a| json!({ "value": a })).collect();
        let raw = match self
            .cmd(
                tab,
                session_id,
                "Runtime.callFunctionOn",
                Some(json!({
                    "objectId": object_id, "functionDeclaration": func,
                    "arguments": call_args, "returnByValue": true,
                })),
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                if is_stale_object_err(&e) {
                    return Err(err_ref_stale("该元素"));
                }
                return Err(e);
            }
        };
        let res: EvalResult = serde_json::from_value(raw)
            .map_err(|e| format!("CDP Runtime.callFunctionOn 结果解析失败: {e}"))?;
        res.err()?;
        match res.result.value {
            Some(v) => serde_json::from_value(v).map_err(|e| format!("元素操作结果解析失败: {e}")),
            None => Ok(T::default()),
        }
    }

    /// 读取当前页面状态;gen==0 表示快照后发生过导航(ref 已失效)。
    pub(crate) async fn status(&self, tab: i64) -> Result<PageStatus, String> {
        self.eval(
            tab,
            "({url:location.href,title:document.title,gen:window.__mcAgentGen||0})",
        )
        .await
    }

    /// 轮询 readyState 至加载完成(interactive/complete)或超时。
    pub(crate) async fn wait_loaded(&self, tab: i64, timeout: Duration) {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            if let Ok(state) = self.eval::<String>(tab, "document.readyState").await {
                if state == "complete" || state == "interactive" {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
}

// ==================== 事件处理(与工具调用并发,注意锁) ====================

impl SessInner {
    /// 桥事件回调(单会话桥:所有事件都到这里;handoff 不经此路,
    /// 桥的待领队列是唯一入口)。
    fn handle_event(self: &Arc<Self>, msg: Message) {
        match msg.event.as_str() {
            EVENT_CDP => self.handle_cdp_event(msg),
            EVENT_TAB_REMOVED => {
                let Some(tab) = msg.tab_id else { return };
                self.cdp.bridge.release_tab(tab);
                let mut st = self.st.lock().unwrap();
                if st.tabs.remove(&tab) {
                    st.add_note(format!("标签页 #{tab} 已被关闭"));
                    if st.tab_id == Some(tab) {
                        st.tab_id = None;
                        st.refs.invalidate();
                    }
                }
            }
            EVENT_DETACHED => {
                let Some(tab) = msg.tab_id else { return };
                let mut st = self.st.lock().unwrap();
                if st.tabs.contains(&tab) {
                    match msg.reason.as_str() {
                        "canceled_by_user" | "released_by_user" => {
                            // 用户主动收回控制权:尊重之,移出会话
                            st.tabs.remove(&tab);
                            st.add_note(format!("用户收回了标签页 #{tab} 的控制权"));
                            if st.tab_id == Some(tab) {
                                st.tab_id = None;
                                st.refs.invalidate();
                            }
                            drop(st);
                            self.cdp.bridge.release_tab(tab);
                        }
                        reason => {
                            // 其他原因(如页面崩溃):保留成员资格,下次操作 attach 自愈
                            st.add_note(format!(
                                "标签页 #{tab} 的调试连接断开({reason}),将自动重连"
                            ));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// 透传的 CDP 事件:主 frame 导航失效 ref 表;JS 对话框自动处理
    /// (alert 确认、confirm/prompt 取消、beforeunload 放行),避免页面阻塞。
    fn handle_cdp_event(self: &Arc<Self>, msg: Message) {
        match msg.method.as_str() {
            "Page.frameNavigated" => {
                let Some(params) = msg.params.as_ref() else { return };
                let parent_id = params
                    .pointer("/frame/parentId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !parent_id.is_empty() {
                    return; // 子 frame 导航不失效主表
                }
                let mut st = self.st.lock().unwrap();
                if msg.tab_id.is_some() && st.tab_id == msg.tab_id {
                    st.refs.invalidate();
                }
            }
            "Page.javascriptDialogOpening" => {
                let typ = msg
                    .params
                    .as_ref()
                    .and_then(|p| p.pointer("/type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let message = msg
                    .params
                    .as_ref()
                    .and_then(|p| p.pointer("/message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let accept = typ == "alert" || typ == "beforeunload";
                let tab = msg.tab_id.unwrap_or(0);
                // 异步应答(对齐 Go 的 go func + 5s 超时);回调可能在 runtime
                // 内(bridge 读循环)或外被调,双路兜底取 handle
                let handle = tokio::runtime::Handle::try_current()
                    .ok()
                    .or_else(|| self.rt.clone());
                if let Some(h) = handle {
                    let cdp = self.cdp.clone();
                    h.spawn(async move {
                        let _ = tokio::time::timeout(
                            Duration::from_secs(5),
                            cdp.cmd(
                                tab,
                                None,
                                "Page.handleJavaScriptDialog",
                                Some(json!({ "accept": accept })),
                            ),
                        )
                        .await;
                    });
                }
                let action = if accept { "已自动确认" } else { "已自动取消" };
                let mut st = self.st.lock().unwrap();
                st.add_note(format!(
                    "页面弹出 {typ} 对话框({action}): {:?}",
                    truncate(&message, 200)
                ));
            }
            _ => {}
        }
    }
}

// ==================== Runtime 域返回结构 ====================

/// Runtime 域返回的远端对象(仅取所需字段)。
#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct RemoteObject {
    /// 值缺失(undefined)或为 null 时均为 None(Go 用 RawMessage 区分,
    /// 但两种情况下游语义一致:Option<bool> 目标同样落 None)。
    pub(crate) value: Option<Value>,
    #[serde(rename = "objectId")]
    pub(crate) object_id: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct EvalResult {
    pub(crate) result: RemoteObject,
    #[serde(rename = "exceptionDetails")]
    pub(crate) exception_details: Option<ExceptionDetails>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct ExceptionDetails {
    text: String,
    exception: Option<ExceptionObj>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct ExceptionObj {
    description: String,
}

impl EvalResult {
    /// 页面脚本抛异常时转为错误(文案对齐 Go evalResult.err)。
    pub(crate) fn err(&self) -> Result<(), String> {
        let Some(ed) = &self.exception_details else {
            return Ok(());
        };
        let mut desc = ed.text.as_str();
        if let Some(ex) = &ed.exception {
            if !ex.description.is_empty() {
                desc = &ex.description;
            }
        }
        Err(format!("页面脚本执行异常: {}", truncate(desc, 300)))
    }
}

/// 轻量页面状态(交互后回报,让模型免于每步 snapshot)。
#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct PageStatus {
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) gen: i64,
}

// ==================== 错误判定与文本辅助 ====================

/// CDP 报文表征"对象/上下文已随导航销毁"(逐条对齐 Go isStaleObjectErr)。
pub(crate) fn is_stale_object_err(msg: &str) -> bool {
    [
        "Cannot find context",
        "Could not find object",
        "Inspected target navigated",
        "Execution context was destroyed",
        // DOM 域:节点已从文档移除 / 无对应节点(getBoxModel 等)
        "No node with given id",
        "Could not find node",
        "Node with given id does not belong",
    ]
    .iter()
    .any(|pat| msg.contains(pat))
}

/// 错误表征 debugger 已被剥离(cmd 自愈据此判定是否重 attach)。
/// 判 bridge.call 前置的稳定标记而非中文文案:文案是产品措辞随时可改,
/// 标记是进程内契约,改文案不会静默破坏自动重连(标记在 MCP 最终出口剥除)。
fn is_detached_err(msg: &str) -> bool {
    msg.contains(ERR_MARK_DETACHED)
}

/// 按字符数截断(对齐 Go 的 rune 截断)。
pub(crate) fn truncate(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        None => s.to_string(),
        Some((idx, _)) => format!("{}...", &s[..idx]),
    }
}

/// 返回第一个非空串(对齐 Go firstNonEmpty)。
pub(crate) fn first_non_empty<'a>(vals: &[&'a str]) -> &'a str {
    for v in vals {
        if !v.is_empty() {
            return v;
        }
    }
    ""
}
