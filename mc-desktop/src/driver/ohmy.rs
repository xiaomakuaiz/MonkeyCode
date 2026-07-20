// OhmyAgentDriver:拉起 ohmyagent --stdio(行分隔 JSON-RPC)并把其事件
// 归一化为 mc-agent Frame 词汇,UI 归约层零改动。
//
// 与 McAgentDriver 的关键差异:
// - ohmyagent 无帧日志 → driver 自记 events.jsonl(<app_config>/ohmy-sessions/
//   <sid>/),打开会话时回放,与实时渲染同一词汇
// - 无会话中途切模型/权限模式协议 → 空闲时 destroy + create{resume, …} 变通
// - permission/respond 无 remember 字段 → driver 自持记忆集,后续同工具
//   请求自动应答不再上抛 UI
// - 会话元数据(标题/归档)ohmyagent 不管 → sidecar meta.json
//
// 事件归一化映射(ohmy → Frame)见 normalize_event;协议参考
// ohmyagent/internal/transport/{stdio,protocol}.go 与 types/events.go。

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};

use super::frame::{self, PermOutcome, SessionStatus};
use crate::config::DesktopConfig;

/// driver 对壳的最小依赖(事件发射 + 配置目录),经 trait 解耦以便
/// 测试注入替身(tauri MockRuntime 与 Wry 的 AppHandle 泛型不互通)。
pub trait ShellCtx: Send + Sync + 'static {
    fn emit_json(&self, event: &str, payload: Value);
    fn config_dir(&self) -> Result<PathBuf, String>;
}

impl ShellCtx for AppHandle {
    fn emit_json(&self, event: &str, payload: Value) {
        // 全局事件(session-event)广播给所有窗口;帧/状态事件仅 main 在听,
        // emit 全局同样可达且省一次 label 匹配失败的分支
        let _ = self.emit(event, payload);
    }
    fn config_dir(&self) -> Result<PathBuf, String> {
        crate::config::config_dir(self)
    }
}

const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const FRAME_FLUSH_MS: u64 = 30;

#[derive(Clone)]
pub struct OhmyDriver(Arc<Inner>);

struct Inner {
    app: Arc<dyn ShellCtx>,
    child: StdMutex<Option<Child>>,
    /// 上行 JSON-RPC 行(writer 线程串行写 stdin;None 哨兵 = 关闭 stdin 触发优雅退出)
    stdin_tx: mpsc::UnboundedSender<Option<String>>,
    pending: StdMutex<HashMap<i64, oneshot::Sender<Value>>>,
    next_id: AtomicI64,
    sessions: StdMutex<HashMap<String, SessionState>>,
    /// 待发帧批量缓冲(sid → 帧列表;flusher 任务 30ms 排空)
    batch: Arc<StdMutex<HashMap<String, Vec<Value>>>>,
    /// 壳清单模型(name → ohmy 模型 id 映射 + 列表展示)
    models: Vec<ManifestModel>,
    /// sidecar 根(<app_config>/ohmy-sessions)
    data_dir: PathBuf,
    /// 审批记忆:工具名集合(内存 = 引擎生命周期;persist 追加落盘)
    perm_remember: StdMutex<HashSet<String>>,
    perm_persist_path: PathBuf,
    /// 未答复的提问(request_id → (sid, questions));答案映射需要原题
    pending_questions: StdMutex<HashMap<String, (String, Value)>>,
    /// 未答复的审批(request_id → sid)
    pending_perms: StdMutex<HashMap<String, String>>,
    /// 审批请求的工具名(request_id → tool;"始终允许"回写记忆集用)
    perm_tools: StdMutex<HashMap<String, String>>,
    stopped: Arc<AtomicBool>,
}

struct SessionState {
    /// 帧序号(回放续接:打开时取日志行数)
    seq: u64,
    running: bool,
    /// 本进程内已 session/create(resume)过
    created: bool,
    /// UI 是否在听 frames:{sid}(未打开时帧只入日志不 emit)
    opened: bool,
    workdir: String,
    model_name: String,
    mode: String,
    title: String,
}

#[derive(Clone)]
struct ManifestModel {
    name: String,
    model: String,
    default: bool,
    source: String,
}

impl OhmyDriver {
    // ==================== 生命周期 ====================

    pub fn start(app: AppHandle, cfg: &DesktopConfig) -> Result<Self, String> {
        Self::start_with(Arc::new(app), cfg)
    }

    pub fn start_with(app: Arc<dyn ShellCtx>, cfg: &DesktopConfig) -> Result<Self, String> {
        if crate::wsl::distro_of(&cfg.kernel_env).is_some() {
            return Err("ohmyagent 引擎暂不支持 WSL 运行环境,请在设置中切换回本机或 mc-agent".into());
        }
        let bin = find_ohmyagent().ok_or_else(|| {
            "找不到 ohmyagent 可执行文件(查找顺序: MC_OHMYAGENT_BIN 环境变量 → 应用同目录 → PATH)".to_string()
        })?;

        let cfg_dir = app.config_dir()?;
        let log_path = cfg_dir.join("ohmyagent.log");
        let log_file = std::fs::File::create(&log_path).ok();

        let mut child = Command::new(&bin)
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log_file.map(Stdio::from).unwrap_or_else(Stdio::null))
            .spawn()
            .map_err(|e| format!("启动 ohmyagent 失败({}): {e}", bin.display()))?;

        let stdin = child.stdin.take().ok_or("ohmyagent stdin 不可用")?;
        let stdout = child.stdout.take().ok_or("ohmyagent stdout 不可用")?;

        let models = parse_manifest_models(&cfg.models);
        let data_dir = cfg_dir.join("ohmy-sessions");
        let _ = std::fs::create_dir_all(&data_dir);
        let perm_persist_path = cfg_dir.join("ohmy-perm-remember.json");
        let perm_remember: HashSet<String> = std::fs::read(&perm_persist_path)
            .ok()
            .and_then(|d| serde_json::from_slice(&d).ok())
            .unwrap_or_default();

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Option<String>>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();

        let inner = Arc::new(Inner {
            app,
            child: StdMutex::new(Some(child)),
            stdin_tx,
            pending: StdMutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            sessions: StdMutex::new(HashMap::new()),
            batch: Arc::new(StdMutex::new(HashMap::new())),
            models,
            data_dir,
            perm_remember: StdMutex::new(perm_remember),
            perm_persist_path,
            pending_questions: StdMutex::new(HashMap::new()),
            pending_perms: StdMutex::new(HashMap::new()),
            perm_tools: StdMutex::new(HashMap::new()),
            stopped: Arc::new(AtomicBool::new(false)),
        });

        // writer 线程:串行写 stdin;收到 None 哨兵或通道关闭即丢弃 stdin
        // (EOF → ohmyagent stdio server 优雅退出)
        std::thread::spawn(move || {
            let mut stdin = stdin;
            loop {
                let msg = tauri::async_runtime::block_on(stdin_rx.recv());
                match msg {
                    Some(Some(line)) => {
                        if stdin.write_all(line.as_bytes()).is_err() || stdin.write_all(b"\n").is_err() {
                            break;
                        }
                        let _ = stdin.flush();
                    }
                    Some(None) | None => break,
                }
            }
            // drop(stdin) → EOF
        });

        // reader 线程:逐行路由(RPC 应答 / 通知)
        let inner_r = inner.clone();
        let crash_log = log_path.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v.get("id").and_then(|i| i.as_i64()).is_some() && v.get("method").is_none() {
                    // RPC 应答
                    let id = v.get("id").and_then(|i| i.as_i64()).unwrap();
                    if let Some(tx) = inner_r.pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(v);
                    }
                    continue;
                }
                let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
                let params = v.get("params").cloned().unwrap_or(Value::Null);
                match method {
                    "system/ready" => {
                        let _ = ready_tx.send(());
                    }
                    _ => inner_r.handle_notification(method, params),
                }
            }
            // stdout EOF = 进程退出:stop() 未置位即崩溃,外显 + 拒掉在途 RPC
            if !inner_r.stopped.load(Ordering::Relaxed) {
                inner_r.pending.lock().unwrap().clear(); // 挂起的 rpc 立即收到"引擎已退出"
                let tail = super::log_tail(&crash_log, 15);
                eprintln!("[mc-desktop] ohmyagent 引擎异常退出");
                inner_r.app.emit_json(
                    "engine-crashed",
                    json!({ "engine": "ohmyagent", "detail": "ohmyagent 进程异常退出", "log_tail": tail }),
                );
            }
        });

        // 批量 flusher:30ms 排空待发帧
        let batch = inner.batch.clone();
        let app2 = inner.app.clone();
        let stopped = inner.stopped.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(FRAME_FLUSH_MS)).await;
                if stopped.load(Ordering::Relaxed) {
                    return;
                }
                let drained: Vec<(String, Vec<Value>)> = {
                    let mut b = batch.lock().unwrap();
                    b.drain().collect()
                };
                for (sid, frames) in drained {
                    if !frames.is_empty() {
                        app2.emit_json(&format!("frames:{sid}"), Value::Array(frames));
                    }
                }
            }
        });

        // 等 system/ready(15s)
        ready_rx
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| "ohmyagent 未在 15 秒内就绪(查看 ohmyagent.log)".to_string())?;
        eprintln!("[mc-desktop] ohmyagent 引擎就绪");
        Ok(OhmyDriver(inner))
    }

    pub fn stop(&self) {
        self.0.stopped.store(true, Ordering::Relaxed);
        let _ = self.0.stdin_tx.send(None); // 关 stdin → 优雅退出
        let Some(mut child) = self.0.child.lock().unwrap().take() else { return };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        eprintln!("[mc-desktop] ohmyagent 未在期限内优雅退出,强制终止");
        let _ = child.kill();
        let _ = child.wait();
    }

    // ==================== JSON-RPC ====================

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.0.pending.lock().unwrap().insert(id, tx);
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
        if self.0.stdin_tx.send(Some(line)).is_err() {
            self.0.pending.lock().unwrap().remove(&id);
            return Err("引擎已退出".into());
        }
        let resp = match tokio::time::timeout(RPC_TIMEOUT, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => return Err("引擎已退出".into()),
            Err(_) => {
                self.0.pending.lock().unwrap().remove(&id);
                return Err(format!("{method} 超时"));
            }
        };
        if let Some(err) = resp.get("error").filter(|e| !e.is_null()) {
            let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("未知错误");
            return Err(msg.to_string());
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    fn notify_rpc(&self, method: &str, params: Value) {
        let line = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
        let _ = self.0.stdin_tx.send(Some(line));
    }

    // ==================== 会话管理 ====================

    /// 会话列表:sidecar 目录是桌面版的权威索引(stdio 模式下 ohmyagent
    /// 不维护 index.json,messages.jsonl 也无 meta 记录,cwd/model 只有壳知道;
    /// CLI 侧建的会话没有 sidecar,自然不出现在桌面列表——引擎间会话隔离)。
    pub async fn sessions_list(&self) -> Result<Value, String> {
        let mut items: Vec<(u64, Value)> = Vec::new();
        let entries = std::fs::read_dir(&self.0.data_dir).map(|it| it.flatten().collect::<Vec<_>>()).unwrap_or_default();
        let sessions = self.0.sessions.lock().unwrap();
        let waiting: HashSet<String> = self
            .0
            .pending_perms
            .lock()
            .unwrap()
            .values()
            .cloned()
            .chain(self.0.pending_questions.lock().unwrap().values().map(|(s, _)| s.clone()))
            .collect();
        for e in entries {
            if !e.path().is_dir() {
                continue;
            }
            let id = e.file_name().to_string_lossy().into_owned();
            let meta = self.read_sidecar(&id);
            if meta.as_object().map(|m| m.is_empty()).unwrap_or(true) {
                continue; // 无 sidecar 的目录不是本壳建的会话
            }
            let running = sessions.get(&id).map(|s| s.running).unwrap_or(false);
            let status = if running {
                "running".to_string()
            } else {
                meta.get("status").and_then(|v| v.as_str()).unwrap_or("finished").to_string()
            };
            let updated = meta.get("updated_at").and_then(|v| v.as_u64()).unwrap_or(0);
            items.push((
                updated,
                json!({
                    "id": id,
                    "title": meta.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                    "workdir": meta.get("workdir").and_then(|v| v.as_str()).unwrap_or(""),
                    "model": meta.get("model_name").and_then(|v| v.as_str()).unwrap_or(""),
                    "mode": meta.get("mode").and_then(|v| v.as_str()).unwrap_or("default"),
                    "turns": meta.get("turns").and_then(|v| v.as_u64()).unwrap_or(0),
                    "status": status,
                    "archived": meta.get("archived").and_then(|v| v.as_bool()).unwrap_or(false),
                    "updated_at": updated,
                    "waiting_ask": waiting.contains(&id),
                }),
            ));
        }
        items.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(Value::Array(items.into_iter().map(|(_, v)| v).collect()))
    }

    pub async fn session_create(&self, workdir: &str, model_name: &str, create_dir: bool) -> Result<Value, String> {
        let model_id = self.model_id_of(model_name)?;
        // ohmyagent 不展开 ~ 也不校验/创建目录(mc-agent 内核会做),壳补齐:
        // 展开主目录、按需创建,否则前置校验——避免建出 cwd 不存在的会话
        let workdir = crate::config::expand_tilde(workdir);
        let workdir = workdir.as_str();
        let exists = std::path::Path::new(workdir).is_dir();
        if !exists {
            if create_dir {
                std::fs::create_dir_all(workdir).map_err(|e| format!("创建工作区目录失败: {e}"))?;
            } else {
                return Err(format!("工作区目录不存在: {workdir}"));
            }
        }
        let result = self
            .rpc("session/create", json!({ "cwd": workdir, "model": model_id }))
            .await?;
        let sid = result
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("session/create 未返回 session_id")?
            .to_string();
        self.0.sessions.lock().unwrap().insert(
            sid.clone(),
            SessionState {
                seq: 0,
                running: false,
                created: true,
                opened: false,
                workdir: workdir.to_string(),
                model_name: model_name.to_string(),
                mode: "default".into(),
                title: String::new(),
            },
        );
        self.write_sidecar(&sid, |m| {
            m["model_name"] = json!(model_name);
            m["workdir"] = json!(workdir);
            m["status"] = json!(SessionStatus::Finished.as_str());
        });
        Ok(json!({
            "id": sid, "title": "", "workdir": workdir, "model": model_name,
            "mode": "default", "turns": 0, "status": "finished",
        }))
    }

    pub async fn session_open(&self, id: &str) -> Result<(), String> {
        // 幂等:确保 resume + 标记 opened + 回放日志
        let need_create = {
            let sessions = self.0.sessions.lock().unwrap();
            !sessions.get(id).map(|s| s.created).unwrap_or(false)
        };
        if need_create {
            let result = self.rpc("session/create", json!({ "resume": id })).await?;
            let _ = result;
            let meta = self.read_sidecar(id);
            self.0.sessions.lock().unwrap().entry(id.to_string()).or_insert(SessionState {
                seq: 0,
                running: false,
                created: true,
                opened: false,
                workdir: meta.get("workdir").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                model_name: meta.get("model_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                mode: meta.get("mode").and_then(|v| v.as_str()).unwrap_or("default").to_string(),
                title: meta.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            }).created = true;
        }
        // 回放日志(重开页面/重连:整份重放,行为与 mc-agent 回放一致)。
        // 顺序保证不重帧:先置 opened=false 并清掉该会话的批量缓冲(其中的帧
        // 已在日志里,会随回放送达),读日志期间新帧只入日志不入缓冲,
        // 最后才置 opened=true 接实时流。seq 取 max 防回放期间并发帧的序号回卷。
        {
            let mut sessions = self.0.sessions.lock().unwrap();
            if let Some(s) = sessions.get_mut(id) {
                s.opened = false;
            }
        }
        self.0.batch.lock().unwrap().remove(id);
        let journal = self.read_journal(id);
        {
            let mut sessions = self.0.sessions.lock().unwrap();
            if let Some(s) = sessions.get_mut(id) {
                s.opened = true;
                s.seq = s.seq.max(journal.len() as u64);
            }
        }
        self.0.app.emit_json(&format!("conn-status:{id}"), json!({ "text": "已连接", "connected": true }));
        if !journal.is_empty() {
            self.0.app.emit_json(&format!("frames:{id}"), Value::Array(journal));
        }
        Ok(())
    }

    pub async fn session_close(&self, id: &str) {
        if let Some(s) = self.0.sessions.lock().unwrap().get_mut(id) {
            s.opened = false;
        }
        // 不 destroy:后台任务继续跑(与 mc-agent 关闭页面语义一致)
    }

    pub async fn session_delete(&self, id: &str) -> Result<Value, String> {
        {
            let sessions = self.0.sessions.lock().unwrap();
            if sessions.get(id).map(|s| s.running).unwrap_or(false) {
                return Err("会话正在执行,请先取消".into());
            }
        }
        let created = self.0.sessions.lock().unwrap().get(id).map(|s| s.created).unwrap_or(false);
        if created {
            let _ = self.rpc("session/destroy", json!({ "session_id": id })).await;
        }
        self.0.sessions.lock().unwrap().remove(id);
        // 删 ohmyagent 会话目录(messages.jsonl)+ 壳 sidecar(含帧日志)
        if let Some(home) = crate::config::home_dir() {
            let root = home.join(".ohmyagent").join("sessions");
            let _ = std::fs::remove_dir_all(root.join(id));
        }
        let _ = std::fs::remove_dir_all(self.0.data_dir.join(id));
        Ok(json!({ "ok": true }))
    }

    pub async fn session_patch(&self, id: &str, patch: Value) -> Result<Value, String> {
        self.write_sidecar(id, |m| {
            if let Some(t) = patch.get("title").and_then(|v| v.as_str()) {
                // 按字符截断:String::truncate 是字节索引,中文标题在非字符
                // 边界截断会 panic
                let t: String = t.trim().chars().take(80).collect();
                m["title"] = json!(t);
            }
            if let Some(a) = patch.get("archived").and_then(|v| v.as_bool()) {
                m["archived"] = json!(a);
            }
        });
        if let Some(t) = patch.get("title").and_then(|v| v.as_str()) {
            if let Some(s) = self.0.sessions.lock().unwrap().get_mut(id) {
                s.title = t.to_string();
            }
        }
        Ok(json!({ "ok": true }))
    }

    pub async fn models_list(&self) -> Result<Value, String> {
        Ok(Value::Array(
            self.0
                .models
                .iter()
                .map(|m| json!({ "name": m.name, "default": m.default, "source": m.source }))
                .collect(),
        ))
    }

    pub async fn session_workdir(&self, id: &str) -> Result<String, String> {
        if let Some(s) = self.0.sessions.lock().unwrap().get(id) {
            if !s.workdir.is_empty() {
                return Ok(s.workdir.clone());
            }
        }
        let meta = self.read_sidecar(id);
        meta.get("workdir")
            .and_then(|v| v.as_str())
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("会话 {id} 不存在"))
    }

    // ==================== 对话 ====================

    pub async fn session_send(&self, id: &str, ftype: &str, payload: Value) -> Result<(), String> {
        match ftype {
            "user-input" => {
                let content_b64 = payload.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let text = base64::engine::general_purpose::STANDARD
                    .decode(content_b64)
                    .ok()
                    .and_then(|b| String::from_utf8(b).ok())
                    .unwrap_or_default();
                if text.is_empty() {
                    return Err("空输入".into());
                }
                // 忙碌守卫:执行中不再开轮(UI 侧已排队,这里兜底;
                // 不能靠引擎拒绝——乐观帧先落,误开轮会污染回放)
                {
                    let mut sessions = self.0.sessions.lock().unwrap();
                    let Some(s) = sessions.get_mut(id) else {
                        return Err("会话未打开".into());
                    };
                    if s.running {
                        return Err("当前会话已有任务在执行,请等待完成或先取消".into());
                    }
                    s.running = true;
                    if s.title.is_empty() {
                        s.title = text.lines().next().unwrap_or("").chars().take(40).collect();
                    }
                }
                // 本地先行落帧:sendMessage 的 ack 与首批事件在 stdout 上没有
                // 先后保证(引擎收到即起 goroutine 跑轮,快模型下整轮事件可能
                // 先于 ack 到达),回显与开轮不能依赖 ack 时序。
                // user_message 引擎回显事件相应地在 handle_event 里忽略。
                self.push_frame(id, |seq| frame::user_input(&text, seq));
                self.push_frame(id, frame::task_started);
                let title = self.session_title(id);
                self.write_sidecar(id, |m| {
                    m["status"] = json!(SessionStatus::Running.as_str());
                    if m.get("title").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                        m["title"] = json!(title);
                    }
                    let turns = m.get("turns").and_then(|v| v.as_u64()).unwrap_or(0);
                    m["turns"] = json!(turns + 1);
                });
                self.emit_session_event(id, SessionStatus::Running.as_str());
                match self.rpc("session/sendMessage", json!({ "session_id": id, "message": text })).await {
                    Ok(_) => Ok(()),
                    Err(e) => {
                        // 引擎没接活:补终止帧关轮,状态回落,错误上抛(UI 保留输入)
                        if let Some(s) = self.0.sessions.lock().unwrap().get_mut(id) {
                            s.running = false;
                        }
                        self.push_frame(id, |seq| frame::task_error(&e, seq));
                        self.push_frame(id, frame::task_ended);
                        self.write_sidecar(id, |m| m["status"] = json!(SessionStatus::Error.as_str()));
                        self.emit_session_event(id, SessionStatus::Error.as_str());
                        Err(e)
                    }
                }
            }
            "user-cancel" => {
                self.rpc("cancel", json!({ "session_id": id })).await.map(|_| ())
            }
            "permission-resp" => {
                let req_id = payload.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let approved = payload.get("approved").and_then(|v| v.as_bool()).unwrap_or(false);
                let remember = payload.get("remember").and_then(|v| v.as_bool()).unwrap_or(false);
                let persist = payload.get("persist").and_then(|v| v.as_bool()).unwrap_or(false);
                self.notify_rpc("permission/respond", json!({ "request_id": req_id, "approved": approved }));
                let tool = self.take_perm_tool(&req_id);
                if approved && remember {
                    if let Some(tool) = tool {
                        self.0.perm_remember.lock().unwrap().insert(tool);
                        if persist {
                            let set = self.0.perm_remember.lock().unwrap().clone();
                            let _ = std::fs::write(
                                &self.0.perm_persist_path,
                                serde_json::to_vec_pretty(&set).unwrap_or_default(),
                            );
                        }
                    }
                }
                self.resolve_perm(id, &req_id, if approved { PermOutcome::Approved } else { PermOutcome::Denied });
                Ok(())
            }
            "reply-question" => {
                let req_id = payload.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let answers_json = payload.get("answers_json").and_then(|v| v.as_str()).unwrap_or("{}");
                let cancelled = payload.get("cancelled").and_then(|v| v.as_bool()).unwrap_or(false);
                let answers: HashMap<String, Value> = serde_json::from_str(answers_json).unwrap_or_default();
                let stored = self.0.pending_questions.lock().unwrap().remove(&req_id);
                let ua: Vec<Value> = stored
                    .as_ref()
                    .and_then(|(_, qs)| qs.as_array())
                    .map(|qs| {
                        qs.iter()
                            .map(|q| {
                                let question = q.get("question").and_then(|v| v.as_str()).unwrap_or("");
                                let header = q.get("header").and_then(|v| v.as_str()).unwrap_or("");
                                let ans = answers.get(question);
                                let selected: Vec<String> = match ans {
                                    Some(Value::String(s)) => vec![s.clone()],
                                    Some(Value::Array(a)) => {
                                        a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()
                                    }
                                    _ => vec![],
                                };
                                // 自由输入 = 答案不在候选项里
                                let opts: HashSet<String> = q
                                    .get("options")
                                    .and_then(|v| v.as_array())
                                    .map(|a| {
                                        a.iter()
                                            .filter_map(|o| o.get("label").and_then(|l| l.as_str()).map(str::to_string))
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                let custom = selected.iter().any(|s| !opts.contains(s));
                                json!({ "header": header, "question": question, "selected": selected, "custom": custom })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.notify_rpc(
                    "question/respond",
                    json!({ "request_id": req_id, "answers": ua, "cancelled": cancelled }),
                );
                // 回显帧入日志(回放可见答案)
                self.push_frame(id, |seq| frame::reply_question(&req_id, answers_json, cancelled, seq));
                self.emit_session_ask(id, false);
                Ok(())
            }
            other => Err(format!("ohmyagent 引擎不支持上行帧 {other}")),
        }
    }

    pub async fn session_call(&self, id: &str, kind: &str, payload: Value) -> Result<Value, String> {
        match kind {
            "session_set_model" => {
                let name = payload.get("model").and_then(|v| v.as_str()).unwrap_or("");
                self.model_id_of(name)?; // 前置校验,未知模型不动会话
                self.recreate(id, Some(name), None).await?;
                if let Some(s) = self.0.sessions.lock().unwrap().get_mut(id) {
                    s.model_name = name.to_string();
                }
                self.write_sidecar(id, |m| m["model_name"] = json!(name));
                self.push_frame(id, |seq| frame::model_update(name, seq));
                Ok(json!({ "result": { "model": name } }))
            }
            "session_set_mode" => {
                let mode = payload.get("mode").and_then(|v| v.as_str()).unwrap_or("default");
                self.recreate(id, None, Some(mode)).await?;
                if let Some(s) = self.0.sessions.lock().unwrap().get_mut(id) {
                    s.mode = mode.to_string();
                }
                self.write_sidecar(id, |m| m["mode"] = json!(mode));
                self.push_frame(id, |seq| frame::permission_mode_update(mode, seq));
                Ok(json!({ "result": { "mode": mode } }))
            }
            other => Ok(json!({ "error": format!("ohmyagent 引擎不支持 {other}") })),
        }
    }

    /// destroy + resume 重建(切模型/权限模式的变通;仅空闲时)。
    /// 重建总是同时带上 model 与 permission_mode(覆盖项 + 会话当前值),
    /// 缺参会被 ohmyagent 回落到进程默认值——单项切换不能重置另一项。
    async fn recreate(&self, id: &str, model_name: Option<&str>, mode: Option<&str>) -> Result<(), String> {
        let (cur_model, cur_mode) = {
            let sessions = self.0.sessions.lock().unwrap();
            let s = sessions.get(id);
            if s.map(|s| s.running).unwrap_or(false) {
                return Err("执行中不能切换,请先取消当前任务".into());
            }
            (
                s.map(|s| s.model_name.clone()).unwrap_or_default(),
                s.map(|s| s.mode.clone()).unwrap_or_else(|| "default".into()),
            )
        };
        let model_id = self.model_id_of(model_name.unwrap_or(&cur_model))?;
        let mode = mode.unwrap_or(&cur_mode);
        let ohmy_mode = if mode == "yolo" { "bypassPermissions" } else { "default" };
        let created = self.0.sessions.lock().unwrap().get(id).map(|s| s.created).unwrap_or(false);
        if created {
            self.rpc("session/destroy", json!({ "session_id": id })).await?;
        }
        self.rpc(
            "session/create",
            json!({ "resume": id, "model": model_id, "permission_mode": ohmy_mode }),
        )
        .await?;
        if let Some(s) = self.0.sessions.lock().unwrap().get_mut(id) {
            s.created = true;
        }
        Ok(())
    }

    // ==================== 辅助 ====================

    fn model_id_of(&self, name: &str) -> Result<String, String> {
        if name.is_empty() {
            return self
                .0
                .models
                .iter()
                .find(|m| m.default)
                .or(self.0.models.first())
                .map(|m| m.model.clone())
                .ok_or_else(|| "尚未配置模型,请先在设置中添加".into());
        }
        self.0
            .models
            .iter()
            .find(|m| m.name == name)
            .map(|m| m.model.clone())
            .ok_or_else(|| format!("未知模型 {name:?}"))
    }

    fn session_title(&self, id: &str) -> String {
        self.0.sessions.lock().unwrap().get(id).map(|s| s.title.clone()).unwrap_or_default()
    }

    fn read_sidecar(&self, id: &str) -> Value {
        self.0.read_sidecar(id)
    }

    fn write_sidecar(&self, id: &str, f: impl FnOnce(&mut Value)) {
        self.0.write_sidecar(id, f)
    }

    fn read_journal(&self, id: &str) -> Vec<Value> {
        let path = self.0.data_dir.join(id).join("events.jsonl");
        let Ok(data) = std::fs::read_to_string(path) else { return vec![] };
        data.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    /// 追加一帧:编 seq → 入日志 → (opened 时)入批量缓冲。
    fn push_frame(&self, sid: &str, build: impl FnOnce(u64) -> Value) {
        self.0.push_frame(sid, build)
    }

    fn emit_session_event(&self, sid: &str, status: &str) {
        self.0.emit_session_event(sid, status)
    }

    fn emit_session_ask(&self, sid: &str, open: bool) {
        self.0.emit_session_ask(sid, open)
    }

    fn resolve_perm(&self, sid: &str, req_id: &str, outcome: PermOutcome) {
        self.0.resolve_perm(sid, req_id, outcome)
    }

    fn take_perm_tool(&self, req_id: &str) -> Option<String> {
        self.0.perm_tools.lock().unwrap().remove(req_id)
    }
}

impl Inner {
    fn sidecar_path(&self, id: &str) -> PathBuf {
        self.data_dir.join(id).join("meta.json")
    }

    fn read_sidecar(&self, id: &str) -> Value {
        std::fs::read(self.sidecar_path(id))
            .ok()
            .and_then(|d| serde_json::from_slice(&d).ok())
            .unwrap_or_else(|| json!({}))
    }

    fn write_sidecar(&self, id: &str, f: impl FnOnce(&mut Value)) {
        let mut meta = self.read_sidecar(id);
        f(&mut meta);
        meta["updated_at"] = json!(frame::now_ms());
        let path = self.sidecar_path(id);
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, serde_json::to_vec_pretty(&meta).unwrap_or_default());
    }

    fn push_frame(&self, sid: &str, build: impl FnOnce(u64) -> Value) {
        let (f, opened) = {
            let mut sessions = self.sessions.lock().unwrap();
            let Some(s) = sessions.get_mut(sid) else { return };
            s.seq += 1;
            (build(s.seq), s.opened)
        };
        // 日志逐帧实时落盘(回放的权威来源)
        let dir = self.data_dir.join(sid);
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("events.jsonl")) {
            let _ = writeln!(file, "{f}");
        }
        if opened {
            self.batch.lock().unwrap().entry(sid.to_string()).or_default().push(f);
        }
    }

    fn emit_session_event(&self, sid: &str, status: &str) {
        let title = self.sessions.lock().unwrap().get(sid).map(|s| s.title.clone()).unwrap_or_default();
        self.app.emit_json(
            "session-event",
            json!({ "type": "session-status", "id": sid, "status": status, "title": title }),
        );
    }

    fn emit_session_ask(&self, sid: &str, open: bool) {
        let title = self.sessions.lock().unwrap().get(sid).map(|s| s.title.clone()).unwrap_or_default();
        self.app.emit_json(
            "session-event",
            json!({ "type": "session-ask", "id": sid, "title": title, "open": open }),
        );
    }

    fn resolve_perm(&self, sid: &str, req_id: &str, outcome: PermOutcome) {
        self.pending_perms.lock().unwrap().remove(req_id);
        self.push_frame(sid, |seq| frame::permission_resolved(req_id, outcome, seq));
        self.emit_session_ask(sid, false);
    }

    /// stdio 通知路由(reader 线程调用)。
    fn handle_notification(&self, method: &str, params: Value) {
        match method {
            "event/stream" => self.handle_event(params),
            "permission/request" => {
                let req_id = params.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let sid = params.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let tool = params.get("tool").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let input = params.get("input").cloned().unwrap_or(Value::Null);
                if req_id.is_empty() || sid.is_empty() {
                    return;
                }
                // 记忆集命中 → 自动放行,不上抛 UI
                if self.perm_remember.lock().unwrap().contains(&tool) {
                    let line = json!({ "jsonrpc": "2.0", "method": "permission/respond",
                        "params": { "request_id": req_id, "approved": true } })
                    .to_string();
                    let _ = self.stdin_tx.send(Some(line));
                    return;
                }
                let title = perm_title(&tool, &input);
                self.pending_perms.lock().unwrap().insert(req_id.clone(), sid.clone());
                self.perm_tools.lock().unwrap().insert(req_id.clone(), tool.clone());
                self.push_frame(&sid, |seq| frame::permission_req(&req_id, &tool, &title, seq));
                self.emit_session_ask(&sid, true);
            }
            "permission/cancelled" => {
                let req_id = params.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let sid = params.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let reason = params.get("reason").and_then(|v| v.as_str()).unwrap_or("cancelled");
                self.perm_tools.lock().unwrap().remove(&req_id);
                if !sid.is_empty() {
                    self.resolve_perm(
                        &sid,
                        &req_id,
                        if reason == "timeout" { PermOutcome::Timeout } else { PermOutcome::Cancelled },
                    );
                }
            }
            "question/request" => {
                let req_id = params.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let sid = params.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let questions = params.get("questions").cloned().unwrap_or(json!([]));
                if req_id.is_empty() || sid.is_empty() {
                    return;
                }
                self.pending_questions
                    .lock()
                    .unwrap()
                    .insert(req_id.clone(), (sid.clone(), questions.clone()));
                // kind=acp_ask_user_question 即一等公民提问卡标记,reduce.ts 据此
                // 直接消费 rawInput.questions,不走 tool_call 的标题启发式
                self.push_frame(&sid, |seq| frame::ask_user_question(&req_id, &questions, seq));
                self.emit_session_ask(&sid, true);
            }
            "question/cancelled" => {
                let req_id = params.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let sid = self.pending_questions.lock().unwrap().remove(&req_id).map(|(s, _)| s);
                if let Some(sid) = sid {
                    self.emit_session_ask(&sid, false);
                }
            }
            "turn/stopped" => {
                let sid = params.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let stop_reason = params.get("stop_reason").and_then(|v| v.as_str()).unwrap_or("complete");
                let err = params.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if sid.is_empty() {
                    return;
                }
                if let Some(s) = self.sessions.lock().unwrap().get_mut(&sid) {
                    s.running = false;
                }
                // 状态词汇对齐 SessionStatus:取消是 interrupted,
                // 不能混进 finished(桌宠会当作完成来庆祝)
                let status = match stop_reason {
                    "error" => SessionStatus::Error,
                    "interrupted" => SessionStatus::Interrupted,
                    _ => SessionStatus::Finished,
                };
                if stop_reason == "error" && !err.is_empty() {
                    self.push_frame(&sid, |seq| frame::task_error(&err, seq));
                }
                self.push_frame(&sid, frame::task_ended);
                // sidecar 状态落盘(重启后列表可见;write_sidecar 一并刷 updated_at)
                self.write_sidecar(&sid, |m| m["status"] = json!(status.as_str()));
                self.emit_session_event(&sid, status.as_str());
            }
            _ => {}
        }
    }

    /// event/stream 事件归一化 → Frame。
    fn handle_event(&self, event: Value) {
        let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let sid = event.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if sid.is_empty() {
            return;
        }
        let data = event.get("data").cloned().unwrap_or(Value::Null);
        match etype {
            // user_message:引擎回显忽略——session_send 已本地先行落 user-input
            // 帧(ack 与事件无时序保证,双写会重复气泡)
            "user_message" => {}
            "model_delta" => {
                let text = data.get("text").and_then(|v| v.as_str()).unwrap_or("");
                self.push_frame(&sid, |seq| frame::agent_text(text, seq));
            }
            "thinking_delta" => {
                let text = data.get("text").and_then(|v| v.as_str()).unwrap_or("");
                self.push_frame(&sid, |seq| frame::agent_thought(text, seq));
            }
            "tool_call" => {
                let tc_id = event
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .or_else(|| data.get("id").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string();
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("工具调用").to_string();
                let input = data.get("input").cloned().unwrap_or(Value::Null);
                let title = perm_title(&name, &input);
                self.push_frame(&sid, |seq| frame::tool_call(&tc_id, &title, &input, seq));
            }
            "tool_result" => {
                let tc_id = event.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
                self.push_frame(&sid, |seq| frame::tool_call_completed(&tc_id, content, seq));
            }
            "send_user_message" | "task_notification" => {
                let msg = data
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| data.as_str().unwrap_or("").to_string());
                if msg.is_empty() {
                    return;
                }
                let text = if etype == "task_notification" { format!("\n📌 {msg}\n") } else { msg };
                self.push_frame(&sid, |seq| frame::agent_text(&text, seq));
            }
            "compaction" => {
                self.push_frame(&sid, |seq| frame::compact_status("started", seq));
                self.push_frame(&sid, |seq| frame::compact_status("ended", seq));
            }
            "error" => {
                let msg = data.get("error").and_then(|v| v.as_str()).unwrap_or("未知错误");
                self.push_frame(&sid, |seq| frame::task_error(msg, seq));
            }
            // model_start/model_done/turn_done:轮次边界以 turn/stopped 为准
            _ => {}
        }
    }
}

/// 工具标题:「名称 主参数」(对齐 mc-agent「动词 目标」的可读形态)。
fn perm_title(tool: &str, input: &Value) -> String {
    let arg = ["file_path", "path", "command", "pattern", "url", "cwd"]
        .iter()
        .find_map(|k| input.get(k).and_then(|v| v.as_str()))
        .unwrap_or("");
    if arg.is_empty() {
        tool.to_string()
    } else {
        let short: String = arg.chars().take(80).collect();
        format!("{tool} {short}")
    }
}

/// 清单模型解析(壳 models.json 词汇:name/provider/base_url/api_key/model/…)。
fn parse_manifest_models(models: &Value) -> Vec<ManifestModel> {
    let Some(arr) = models.as_array() else { return vec![] };
    arr.iter()
        .filter_map(|m| {
            let name = m.get("name").and_then(|v| v.as_str())?.to_string();
            let model = m.get("model").and_then(|v| v.as_str()).unwrap_or(&name).to_string();
            Some(ManifestModel {
                name,
                model,
                default: m.get("default").and_then(|v| v.as_bool()).unwrap_or(false),
                source: m.get("source").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// 查找 ohmyagent 二进制:MC_OHMYAGENT_BIN → 应用同目录 → PATH(含 ~/.local/bin)。
fn find_ohmyagent() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MC_OHMYAGENT_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let name = if cfg!(windows) { "ohmyagent.exe" } else { "ohmyagent" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default();
    if let Some(home) = crate::config::home_dir() {
        paths.push(home.join(".local/bin"));
    }
    paths.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// 假 Anthropic SSE 服务:任何 POST /v1/messages 都回一段固定的流式应答。
    fn fake_anthropic() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut conn) = conn else { continue };
                std::thread::spawn(move || {
                    use std::io::{BufRead as _, Write as _};
                    let mut reader = std::io::BufReader::new(conn.try_clone().unwrap());
                    let mut line = String::new();
                    let _ = reader.read_line(&mut line);
                    let mut content_len = 0usize;
                    loop {
                        let mut h = String::new();
                        if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                            break;
                        }
                        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                            content_len = v.trim().parse().unwrap_or(0);
                        }
                    }
                    let mut body = vec![0u8; content_len];
                    use std::io::Read as _;
                    let _ = reader.read_exact(&mut body);
                    let events = [
                        r#"event: message_start
data: {"type":"message_start","message":{"id":"m1","role":"assistant","content":[],"model":"test-model","usage":{"input_tokens":10,"output_tokens":0}}}"#,
                        r#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
                        r#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好,任务完成"}}"#,
                        r#"event: content_block_stop
data: {"type":"content_block_stop","index":0}"#,
                        r#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
                        r#"event: message_stop
data: {"type":"message_stop"}"#,
                    ];
                    let sse = events.join("\n\n") + "\n\n";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                        sse.len(),
                        sse
                    );
                    let _ = conn.write_all(resp.as_bytes());
                });
            }
        });
        format!("http://{addr}")
    }

    /// 端到端:mock 壳 + 真实 ohmyagent + 假 LLM,验证 create → send → 归一化
    /// 帧日志(user-input/task-started/agent 文本/task-ended)与回放。
    /// 需要 ohmyagent 二进制:MC_OHMYAGENT_BIN 或 PATH;找不到则跳过。
    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_chat_normalization() {
        if find_ohmyagent().is_none() {
            eprintln!("skip: 未找到 ohmyagent 二进制");
            return;
        }
        // 隔离 HOME(ohmyagent 配置/会话)与壳配置目录
        let home = std::env::temp_dir().join(format!("ohmy-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".ohmyagent")).unwrap();
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_CONFIG_HOME", home.join("xdg"));

        let llm = fake_anthropic();
        let settings = json!({
            "default_model": "test-model",
            "permission_mode": "default",
            "providers": { "anthropic": { "api_key": "sk-fake", "base_url": format!("{llm}/api/anthropic") } },
            "models": [{ "id": "test-model", "provider": "anthropic", "context_window": 200000 }],
        });
        std::fs::write(
            home.join(".ohmyagent/settings.json"),
            serde_json::to_vec_pretty(&settings).unwrap(),
        )
        .unwrap();

        struct TestCtx(PathBuf);
        impl ShellCtx for TestCtx {
            fn emit_json(&self, _event: &str, _payload: Value) {}
            fn config_dir(&self) -> Result<PathBuf, String> {
                Ok(self.0.clone())
            }
        }
        let ctx: Arc<dyn ShellCtx> = Arc::new(TestCtx(home.join("shellcfg")));
        let cfg = DesktopConfig {
            models: json!([{ "name": "测试模型", "provider": "anthropic",
                "base_url": format!("{llm}/api/anthropic"), "api_key": "sk-fake", "model": "test-model", "default": true }]),
            ..Default::default()
        };
        let driver = OhmyDriver::start_with(ctx, &cfg).expect("引擎启动");

        let workdir = home.to_string_lossy().into_owned();
        let meta = driver.session_create(&workdir, "测试模型", false).await.expect("建会话");
        let sid = meta.get("id").and_then(|v| v.as_str()).unwrap().to_string();
        driver.session_open(&sid).await.expect("打开会话");

        let payload = json!({ "content": frame::b64_text("写个 hello world") });
        driver.session_send(&sid, "user-input", payload).await.expect("发送");

        // 轮询帧日志直到 task-ended(假 LLM 一轮即完)
        let mut journal: Vec<Value> = vec![];
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            journal = driver.read_journal(&sid);
            if journal.iter().any(|f| f.get("type").and_then(|v| v.as_str()) == Some("task-ended")) {
                break;
            }
        }
        let types: Vec<&str> = journal.iter().filter_map(|f| f.get("type").and_then(|v| v.as_str())).collect();
        assert!(types.contains(&"task-started"), "缺 task-started: {types:?}");
        assert!(types.contains(&"user-input"), "缺 user-input: {types:?}");
        assert!(types.contains(&"task-ended"), "缺 task-ended: {types:?}");
        // agent 文本增量以 acp_event 形态出现,data 解码后是 agent_message_chunk
        let has_text = journal.iter().any(|f| {
            if f.get("kind").and_then(|v| v.as_str()) != Some("acp_event") {
                return false;
            }
            let Some(data) = f.get("data").and_then(|v| v.as_str()) else { return false };
            let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(data) else { return false };
            let Ok(v) = serde_json::from_slice::<Value>(&raw) else { return false };
            v.get("update").and_then(|u| u.get("sessionUpdate")).and_then(|s| s.as_str())
                == Some("agent_message_chunk")
                && v["update"]["content"]["text"].as_str().map(|t| t.contains("任务完成")).unwrap_or(false)
        });
        assert!(has_text, "缺 agent 文本帧: {journal:?}");
        // seq 单调
        let seqs: Vec<u64> = journal.iter().filter_map(|f| f.get("seq").and_then(|v| v.as_u64())).collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]), "seq 不单调: {seqs:?}");

        // 会话列表(sidecar 权威):标题取首条输入,状态 finished
        let list = driver.sessions_list().await.unwrap();
        let items = list.as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("status").and_then(|v| v.as_str()), Some("finished"));
        assert!(items[0].get("title").and_then(|v| v.as_str()).unwrap_or("").contains("hello world"));

        // 切模型变通路径(destroy + resume-create)在空闲时可用
        driver
            .session_call(&sid, "session_set_mode", json!({ "mode": "yolo" }))
            .await
            .expect("切权限模式");

        driver.stop();
    }
}
