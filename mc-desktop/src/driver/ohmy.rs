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
    /// 引擎私有配置目录(<app_config>/ohmyagent;messages.jsonl 存在性检查用)
    engine_dir: PathBuf,
    /// 审批记忆:工具名集合(内存 = 引擎生命周期;persist 追加落盘)
    perm_remember: StdMutex<HashSet<String>>,
    perm_persist_path: PathBuf,
    /// 未答复的提问(request_id → (sid, questions));答案映射需要原题
    pending_questions: StdMutex<HashMap<String, (String, Value)>>,
    /// 未答复的审批(request_id → sid)
    pending_perms: StdMutex<HashMap<String, String>>,
    /// 审批请求的工具名(request_id → tool;"始终允许"回写记忆集用)
    perm_tools: StdMutex<HashMap<String, String>>,
    /// system/ready 宣告的引擎能力(版本握手:缺 switch RPC 时回退 destroy+resume)
    engine_caps: StdMutex<HashSet<String>>,
    /// 子代理事件路由(child_sid → 父会话/父 Agent 工具)。上游把子循环事件
    /// 原样转发,session_id 是子循环的随机 id,不带父归属——首次见到时
    /// 用"运行中且持有未闭合 Agent 工具的会话"启发式认领
    subagents: StdMutex<HashMap<String, SubagentRoute>>,
    /// 父会话 Agent 工具入参暂存(tc_id → (description, prompt)),
    /// 子会话物化时作标题与首条输入
    agent_inputs: StdMutex<HashMap<String, (String, String)>>,
    stopped: Arc<AtomicBool>,
}

struct SubagentRoute {
    parent_sid: String,
    parent_tc: String,
    /// model_delta 行缓冲:凑整行再出 subagent_text(防每 token 一帧)
    line_buf: String,
}

struct SessionState {
    /// 帧序号(回放续接:打开时取日志行数)
    seq: u64,
    running: bool,
    /// 本进程内已 session/create(resume)过
    created: bool,
    /// 引擎侧会话 id(通常 == 壳 sid;空会话无法 resume 时壳会 destroy +
    /// 全新 create,引擎发新 id——壳 sid/目录/UI 通道保持不变,仅此别名换绑。
    /// 出站 RPC 用它,入站事件经 shell_sid_of 反查;sidecar 持久化)
    engine_id: String,
    /// UI 是否在听 frames:{sid}(未打开时帧只入日志不 emit)
    opened: bool,
    /// 已发 tool_call 未见 tool_result 的调用(tc_id → 工具名)。
    /// 引擎错误路径不发 tool_result,轮次收尾时对余量补 failed 帧;
    /// 工具名用于子代理事件认领(找未闭合的 Agent 工具)
    open_tools: HashMap<String, String>,
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
            return Err("WSL 运行环境暂未支持(移植中),请在设置中切换回本机".into());
        }
        let bin = find_ohmyagent().ok_or_else(|| {
            "找不到 ohmyagent 可执行文件(查找顺序: MC_OHMYAGENT_BIN 环境变量 → 应用同目录 → PATH)".to_string()
        })?;

        let cfg_dir = app.config_dir()?;
        let log_path = cfg_dir.join("ohmyagent.log");
        let log_file = std::fs::File::create(&log_path).ok();

        // 引擎私有配置目录(OHMYAGENT_CONFIG_DIR):settings/sessions/mcp 等
        // 全部派生路径随之落在 app_config_dir/ohmyagent,不再接管全局 ~/.ohmyagent。
        // 一次性迁移:旧接管目录的 sessions 拷过来(sidecar 权威过滤,多拷无害)。
        let engine_dir = cfg_dir.join("ohmyagent");
        migrate_legacy_sessions(&engine_dir);

        // 进程 cwd 定在主目录:打包应用从 Finder/Dock 启动时壳 cwd 是 "/",
        // 会漏给引擎的 os.Getwd 兜底与其 spawn 的 MCP stdio 子进程;
        // 会话工作目录不受影响(session/create 逐会话显式传 cwd)
        let proc_cwd = crate::config::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let mut child = Command::new(&bin)
            .current_dir(&proc_cwd)
            .env("OHMYAGENT_CONFIG_DIR", &engine_dir)
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
            engine_dir,
            perm_remember: StdMutex::new(perm_remember),
            perm_persist_path,
            pending_questions: StdMutex::new(HashMap::new()),
            pending_perms: StdMutex::new(HashMap::new()),
            perm_tools: StdMutex::new(HashMap::new()),
            engine_caps: StdMutex::new(HashSet::new()),
            subagents: StdMutex::new(HashMap::new()),
            agent_inputs: StdMutex::new(HashMap::new()),
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
                        // 版本握手:记录引擎宣告的能力,缺口路径运行时回退
                        let caps: HashSet<String> = params
                            .get("capabilities")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        let version =
                            params.get("version").and_then(|v| v.as_str()).unwrap_or("?").to_string();
                        eprintln!("[mc-desktop] ohmyagent 就绪 version={version} caps={}", caps.len());
                        *inner_r.engine_caps.lock().unwrap() = caps;
                        let _ = ready_tx.send(());
                    }
                    _ => inner_r.handle_notification(method, params),
                }
            }
            // stdout EOF = 进程退出:stop() 未置位即崩溃,外显 + 拒掉在途 RPC
            if !inner_r.stopped.load(Ordering::Relaxed) {
                inner_r.pending.lock().unwrap().clear(); // 挂起的 rpc 立即收到"引擎已退出"
                inner_r.reconcile_all("引擎进程异常退出"); // 运行中会话本地收尾,不留永久 running
                let tail = super::log_tail(&crash_log, 15);
                eprintln!("[mc-desktop] ohmyagent 引擎异常退出");
                inner_r.app.emit_json(
                    "engine-crashed",
                    json!({ "engine": "ohmyagent", "detail": "ohmyagent 进程异常退出", "log_tail": tail }),
                );
            }
        });

        // 批量 flusher:30ms 排空待发帧
        let inner_f = inner.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(FRAME_FLUSH_MS)).await;
                if inner_f.stopped.load(Ordering::Relaxed) {
                    return;
                }
                inner_f.flush_batch();
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
        // 先本地和解运行中会话(补收尾帧)并同步排空缓冲——
        // 此后 flusher 退出也不丢帧,sidecar 不会残留 running
        self.0.reconcile_all("引擎已停止");
        self.0.flush_batch();
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
            if meta.get("parent").and_then(|v| v.as_str()).map(|p| !p.is_empty()).unwrap_or(false) {
                continue; // 子代理子会话不进列表(经父会话工具卡点开,与 mc-agent 一致)
            }
            let running = sessions.get(&id).map(|s| s.running).unwrap_or(false);
            let status = if running {
                "running".to_string()
            } else {
                match meta.get("status").and_then(|v| v.as_str()).unwrap_or("finished") {
                    // 历史遗留的 sidecar "running"(和解机制上线前的崩溃残留):
                    // 内存里没在跑就不是在跑,读取时自愈为 interrupted
                    "running" => "interrupted".to_string(),
                    s => s.to_string(),
                }
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
                    // 契约:SessionMeta.updated_at 是 RFC3339 字符串(与 mc-agent 的
                    // time.Time 序列化对表);sidecar 内部存毫秒,输出时转换
                    "updated_at": crate::config::ms_to_rfc3339(updated),
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
                engine_id: sid.clone(),
                opened: false,
                open_tools: HashMap::new(),
                workdir: workdir.to_string(),
                model_name: model_name.to_string(),
                mode: "default".into(),
                title: String::new(),
            },
        );
        // 契约 5:新建未运行的会话是 created,不是 finished(否则侧栏打勾、桌宠庆祝)
        self.write_sidecar(&sid, |m| {
            m["model_name"] = json!(model_name);
            m["workdir"] = json!(workdir);
            m["status"] = json!(SessionStatus::Created.as_str());
        });
        Ok(json!({
            "id": sid, "title": "", "workdir": workdir, "model": model_name,
            "mode": "default", "turns": 0, "status": SessionStatus::Created.as_str(),
        }))
    }

    pub async fn session_open(&self, id: &str) -> Result<(), String> {
        // 幂等:确保 resume + 标记 opened + 回放日志
        let need_create = {
            let sessions = self.0.sessions.lock().unwrap();
            !sessions.get(id).map(|s| s.created).unwrap_or(false)
        };
        let mut resume_ctx: Option<(i64, i64)> = None;
        if need_create {
            let meta = self.read_sidecar(id);
            let is_child =
                meta.get("parent").and_then(|v| v.as_str()).map(|p| !p.is_empty()).unwrap_or(false);
            let mut engine_id = meta
                .get("engine_id")
                .and_then(|v| v.as_str())
                .filter(|e| !e.is_empty())
                .unwrap_or(id)
                .to_string();
            if !is_child {
                // 有历史则 resume 带全参(缺参会回落进程默认值);空会话
                // resume 必失败,改全新 create 换绑 engine_id(壳 sid 不变)。
                // 模型已从配置移除时不带 model,退化引擎默认(不阻断打开)
                let mode = meta.get("mode").and_then(|v| v.as_str()).unwrap_or("default");
                let has_history =
                    self.0.engine_dir.join("sessions").join(&engine_id).join("messages.jsonl").is_file();
                let mut params = if has_history {
                    json!({ "resume": engine_id, "permission_mode": ohmy_mode_of(mode) })
                } else {
                    json!({ "cwd": meta.get("workdir").and_then(|v| v.as_str()).unwrap_or(""),
                        "permission_mode": ohmy_mode_of(mode) })
                };
                let model_name = meta.get("model_name").and_then(|v| v.as_str()).unwrap_or("");
                if let Ok(model_id) = self.model_id_of(model_name) {
                    params["model"] = json!(model_id);
                }
                let result = self.rpc("session/create", params).await?;
                if let Some(e) = result.get("session_id").and_then(|v| v.as_str()) {
                    engine_id = e.to_string();
                }
                if engine_id != id {
                    let e = engine_id.clone();
                    self.write_sidecar(id, |m| m["engine_id"] = json!(e));
                }
                // resume 结果带恢复历史的占用估计,立即可显示(296176a)
                resume_ctx = Some((
                    result.get("context_used").and_then(|v| v.as_i64()).unwrap_or(0),
                    result.get("context_window").and_then(|v| v.as_i64()).unwrap_or(0),
                ));
            }
            // 子代理子会话是壳侧实体(仅回放),登记但不向引擎 resume
            let mut sessions = self.0.sessions.lock().unwrap();
            let entry = sessions.entry(id.to_string()).or_insert(SessionState {
                seq: 0,
                running: false,
                created: true,
                engine_id: engine_id.clone(),
                opened: false,
                open_tools: HashMap::new(),
                workdir: meta.get("workdir").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                model_name: meta.get("model_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                mode: meta.get("mode").and_then(|v| v.as_str()).unwrap_or("default").to_string(),
                title: meta.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            });
            entry.created = true;
            entry.engine_id = engine_id.clone();
            drop(sessions);
            if let Some((used, window)) = resume_ctx.take() {
                self.0.push_usage(id, used, window);
            }
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
        let eng = self.engine_id(id);
        if created {
            let _ = self.rpc("session/destroy", json!({ "session_id": eng })).await;
        }
        self.0.sessions.lock().unwrap().remove(id);
        // 级联删子代理子会话(sidecar parent == id;壳侧实体,无引擎目录)
        let children: Vec<String> = std::fs::read_dir(&self.0.data_dir)
            .map(|it| {
                it.flatten()
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|cid| {
                        self.read_sidecar(cid).get("parent").and_then(|v| v.as_str()) == Some(id)
                    })
                    .collect()
            })
            .unwrap_or_default();
        for cid in children {
            self.0.sessions.lock().unwrap().remove(&cid);
            self.0.subagents.lock().unwrap().remove(&cid);
            let _ = std::fs::remove_dir_all(self.0.data_dir.join(&cid));
        }
        // 删 ohmyagent 会话目录(messages.jsonl,目录名是引擎 id)+ 壳 sidecar(含帧日志)
        {
            let root = self.0.engine_dir.join("sessions");
            let _ = std::fs::remove_dir_all(root.join(&eng));
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
                match self
                    .rpc("session/sendMessage", json!({ "session_id": self.engine_id(id), "message": text }))
                    .await
                {
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
                // 引擎应答是确认而非前提:cancel 无应答(挂死/超时)时本地和解,
                // 否则会话永卡 running;引擎若事后仍发 turn/stopped,
                // 幂等守卫(was_running)会吞掉迟到的收尾
                if let Err(e) = self.rpc("cancel", json!({ "session_id": self.engine_id(id) })).await {
                    self.0.reconcile_session(id, &format!("取消未获引擎应答,已本地中断({e})"));
                }
                Ok(())
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
                let model_id = self.model_id_of(name)?; // 前置校验,未知模型不动会话
                // 引擎同样拒绝运行中切模型,本地先给友好错误
                if self.0.sessions.lock().unwrap().get(id).map(|s| s.running).unwrap_or(false) {
                    return Err("执行中不能切换,请先取消当前任务".into());
                }
                if !self.session_created(id) {
                    let mode = self.session_mode(id);
                    self.create_resumed(id, &model_id, &mode).await?;
                } else if self.has_cap("session/switchModel") {
                    self.rpc(
                        "session/switchModel",
                        json!({ "session_id": self.engine_id(id), "model": model_id }),
                    )
                    .await?;
                } else {
                    // 版本握手回退:旧引擎无 switch RPC,destroy+resume 全参重建
                    let mode = self.session_mode(id);
                    self.recreate_fallback(id, &model_id, &mode).await?;
                }
                if let Some(s) = self.0.sessions.lock().unwrap().get_mut(id) {
                    s.model_name = name.to_string();
                }
                self.write_sidecar(id, |m| m["model_name"] = json!(name));
                self.push_frame(id, |seq| frame::model_update(name, seq));
                Ok(json!({ "result": { "model": name } }))
            }
            "session_set_mode" => {
                // 权限模式切换:运行中也可热切(上游子代理评估器已实时继承
                // 父模式,969311a 起热切对后续子代理同样生效)。
                let mode = payload.get("mode").and_then(|v| v.as_str()).unwrap_or("default");
                if !self.session_created(id) {
                    let model_id = self.model_id_of(&self.session_model_name(id))?;
                    self.create_resumed(id, &model_id, mode).await?;
                } else if self.has_cap("session/switchMode") {
                    self.rpc(
                        "session/switchMode",
                        json!({ "session_id": self.engine_id(id), "permission_mode": ohmy_mode_of(mode) }),
                    )
                    .await?;
                } else {
                    // 版本握手回退:旧引擎只能 destroy+resume,那必须空闲
                    if self.0.sessions.lock().unwrap().get(id).map(|s| s.running).unwrap_or(false) {
                        return Err("当前引擎版本较旧,执行中不能切换权限模式,请先取消任务".into());
                    }
                    let model_id = self.model_id_of(&self.session_model_name(id))?;
                    self.recreate_fallback(id, &model_id, mode).await?;
                }
                // 与 mc-agent setMode 对齐:切到 yolo 自动放行本会话所有挂起审批。
                // 先切引擎再排空——切换后引擎新的审批直接放行不再产生 ask,
                // 排空动作不会漏掉切换瞬间的请求
                if mode == "yolo" {
                    let drained: Vec<String> = self
                        .0
                        .pending_perms
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|(_, sid)| sid.as_str() == id)
                        .map(|(req_id, _)| req_id.clone())
                        .collect();
                    for req_id in drained {
                        self.notify_rpc(
                            "permission/respond",
                            json!({ "request_id": req_id, "approved": true }),
                        );
                        self.take_perm_tool(&req_id);
                        self.resolve_perm(id, &req_id, PermOutcome::Approved);
                    }
                }
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

    /// 会话在引擎中(重)建:有历史则 resume 带全参(缺参会回落进程默认值);
    /// 空会话(messages.jsonl 未生成)resume 必失败,改全新 create——
    /// 引擎发新 id,壳 sid/目录/UI 通道不变,engine_id 换绑并落 sidecar。
    async fn create_resumed(&self, id: &str, model_id: &str, mode: &str) -> Result<(), String> {
        let eng = self.engine_id(id);
        let has_history = self.0.engine_dir.join("sessions").join(&eng).join("messages.jsonl").is_file();
        let params = if has_history {
            json!({ "resume": eng, "model": model_id, "permission_mode": ohmy_mode_of(mode) })
        } else {
            let mut workdir =
                self.0.sessions.lock().unwrap().get(id).map(|s| s.workdir.clone()).unwrap_or_default();
            if workdir.is_empty() {
                // 空 workdir 会触发引擎的 os.Getwd 兜底(进程 cwd),显式回退主目录
                workdir = crate::config::home_dir()
                    .map(|h| h.to_string_lossy().into_owned())
                    .unwrap_or_default();
            }
            json!({ "cwd": workdir, "model": model_id, "permission_mode": ohmy_mode_of(mode) })
        };
        let result = self.rpc("session/create", params).await?;
        let new_eng =
            result.get("session_id").and_then(|v| v.as_str()).unwrap_or(&eng).to_string();
        if let Some(s) = self.0.sessions.lock().unwrap().get_mut(id) {
            s.created = true;
            s.engine_id = new_eng.clone();
        }
        if new_eng != id {
            let e = new_eng.clone();
            self.write_sidecar(id, |m| m["engine_id"] = json!(e));
        }
        // resume 结果带恢复历史的占用估计(296176a)
        self.0.push_usage(
            id,
            result.get("context_used").and_then(|v| v.as_i64()).unwrap_or(0),
            result.get("context_window").and_then(|v| v.as_i64()).unwrap_or(0),
        );
        Ok(())
    }

    /// 当前正在执行轮次的(父)会话工作区——浏览器截图落盘定位用。
    /// 桌面单用户下同一时刻通常只有一个运行中的主会话;子代理子会话跳过。
    pub fn active_workdir(&self) -> Option<String> {
        let subs = self.0.subagents.lock().unwrap();
        self.0
            .sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(sid, s)| s.running && !s.workdir.is_empty() && !subs.contains_key(*sid))
            .map(|(_, s)| s.workdir.clone())
    }

    fn session_created(&self, id: &str) -> bool {
        self.0.sessions.lock().unwrap().get(id).map(|s| s.created).unwrap_or(false)
    }

    /// 出站 RPC 用的引擎会话 id(通常 == 壳 sid;空会话重建后换绑,
    /// 未加载时回退 sidecar 记录)。
    fn engine_id(&self, id: &str) -> String {
        if let Some(e) = self.0.sessions.lock().unwrap().get(id).map(|s| s.engine_id.clone()) {
            return e;
        }
        self.read_sidecar(id)
            .get("engine_id")
            .and_then(|v| v.as_str())
            .filter(|e| !e.is_empty())
            .map(String::from)
            .unwrap_or_else(|| id.to_string())
    }

    fn has_cap(&self, cap: &str) -> bool {
        self.0.engine_caps.lock().unwrap().contains(cap)
    }

    /// destroy + 重建实现切换(仅空闲时安全):模式切换的常规路径
    /// (子代理权限顶棚只在构建时生效)与旧引擎无 switch RPC 的回退。
    async fn recreate_fallback(&self, id: &str, model_id: &str, mode: &str) -> Result<(), String> {
        // destroy 容错:引擎侧可能已无此会话(崩溃重启后),不阻断重建
        let _ = self.rpc("session/destroy", json!({ "session_id": self.engine_id(id) })).await;
        if let Some(s) = self.0.sessions.lock().unwrap().get_mut(id) {
            s.created = false;
        }
        self.create_resumed(id, model_id, mode).await
    }

    fn session_mode(&self, id: &str) -> String {
        self.0
            .sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.mode.clone())
            .unwrap_or_else(|| "default".into())
    }

    fn session_model_name(&self, id: &str) -> String {
        self.0.sessions.lock().unwrap().get(id).map(|s| s.model_name.clone()).unwrap_or_default()
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

    /// 排空批量缓冲(flusher 周期调用;stop 前同步调用,保证收尾帧送达)。
    fn flush_batch(&self) {
        let drained: Vec<(String, Vec<Value>)> = {
            let mut b = self.batch.lock().unwrap();
            b.drain().collect()
        };
        for (sid, frames) in drained {
            if !frames.is_empty() {
                self.app.emit_json(&format!("frames:{sid}"), Value::Array(frames));
            }
        }
    }

    /// 引擎不再服务(停止/崩溃/取消无应答)时的本地和解——引擎应答是确认
    /// 而非前提。运行中会话补收尾帧(未闭合工具 failed → task-error →
    /// task-ended),sidecar 落 interrupted;不和解会永久卡"执行中"
    /// (不能发/不能删/不能切,重启也救不回)。
    fn reconcile_session(&self, sid: &str, reason: &str) {
        let open = {
            let mut sessions = self.sessions.lock().unwrap();
            match sessions.get_mut(sid) {
                Some(s) if s.running => {
                    s.running = false;
                    std::mem::take(&mut s.open_tools)
                }
                _ => return,
            }
        };
        self.close_children_of_session(sid, SessionStatus::Interrupted);
        for (tc, _name) in open {
            self.push_frame(sid, |seq| frame::tool_call_failed(&tc, "已中断", seq));
        }
        self.push_frame(sid, |seq| frame::task_error(reason, seq));
        self.push_frame(sid, frame::task_ended);
        self.write_sidecar(sid, |m| m["status"] = json!(SessionStatus::Interrupted.as_str()));
        self.emit_session_event(sid, SessionStatus::Interrupted.as_str());
    }

    fn reconcile_all(&self, reason: &str) {
        // 挂起审批/提问随引擎一起失效(resolved 帧先于 task-ended 落日志)
        let perms: Vec<(String, String)> =
            self.pending_perms.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (req_id, sid) in perms {
            self.perm_tools.lock().unwrap().remove(&req_id);
            self.resolve_perm(&sid, &req_id, PermOutcome::Cancelled);
        }
        let questions: Vec<(String, String)> = self
            .pending_questions
            .lock()
            .unwrap()
            .iter()
            .map(|(k, (s, _))| (k.clone(), s.clone()))
            .collect();
        for (req_id, sid) in questions {
            self.pending_questions.lock().unwrap().remove(&req_id);
            self.emit_session_ask(&sid, false);
        }
        // 子会话跳过:由各自父会话的和解统一收尾(close_children_of_session)
        let ids: Vec<String> = {
            let subs = self.subagents.lock().unwrap();
            self.sessions.lock().unwrap().keys().filter(|id| !subs.contains_key(*id)).cloned().collect()
        };
        for id in ids {
            self.reconcile_session(&id, reason);
        }
    }

    /// stdio 通知路由(reader 线程调用)。
    fn handle_notification(&self, method: &str, params: Value) {
        match method {
            "event/stream" => self.handle_event(params),
            "permission/request" => {
                let req_id = params.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let sid = self.shell_sid_of(params.get("session_id").and_then(|v| v.as_str()).unwrap_or(""));
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
                let sid = self.shell_sid_of(params.get("session_id").and_then(|v| v.as_str()).unwrap_or(""));
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
                let sid = self.shell_sid_of(params.get("session_id").and_then(|v| v.as_str()).unwrap_or(""));
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
                let sid = self.shell_sid_of(params.get("session_id").and_then(|v| v.as_str()).unwrap_or(""));
                let stop_reason = params.get("stop_reason").and_then(|v| v.as_str()).unwrap_or("complete");
                let err = params.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if sid.is_empty() {
                    return;
                }
                let (was_running, open) = {
                    let mut sessions = self.sessions.lock().unwrap();
                    match sessions.get_mut(&sid) {
                        Some(s) => {
                            let was = s.running;
                            s.running = false;
                            (was, std::mem::take(&mut s.open_tools))
                        }
                        None => (false, HashMap::new()),
                    }
                };
                // 轮次收尾:残留子代理(未随工具闭合)按中断收尾
                self.close_children_of_session(&sid, SessionStatus::Interrupted);
                if !was_running {
                    // 已本地和解(取消超时/引擎重启)后迟到的收尾,忽略防重复帧
                    return;
                }
                // 引擎的工具错误路径不发 tool_result(错误只进模型消息),
                // 未闭合的 tool_call 在此补 failed 帧,否则 UI 永远转圈
                let tool_msg =
                    if stop_reason == "interrupted" { "已中断" } else { "执行失败(引擎未回传详情)" };
                for (tc, _name) in open {
                    self.push_frame(&sid, |seq| frame::tool_call_failed(&tc, tool_msg, seq));
                }
                // 轮后上下文占用(见 push_usage 注释)
                if let Some(c) = params.get("context") {
                    self.push_usage(
                        &sid,
                        c.get("used_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
                        c.get("window_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
                    );
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

    /// 子代理认领 + 物化。上游 dab1b85 起事件自带 parent_session_id/
    /// parent_tool_call_id,精确认领;旧引擎无标记时回退"运行中且持有
    /// 未闭合 Agent 工具的会话"启发式。物化为**壳侧子会话**(sidecar 带
    /// parent,可回放可跟流)——父卡 feed 预览 + child_session 链接
    /// 点开完整对话。认领不到(迟到事件)返回 false。
    fn claim_subagent(&self, child_sid: &str, event: &Value) -> bool {
        if self.subagents.lock().unwrap().contains_key(child_sid) {
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
                let sessions = self.sessions.lock().unwrap();
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
                let sessions = self.sessions.lock().unwrap();
                sessions.iter().find_map(|(sid, s)| {
                    if !s.running {
                        return None;
                    }
                    s.open_tools
                        .iter()
                        .find(|(_, name)| name.as_str() == "Agent")
                        .map(|(tc, _)| (sid.clone(), tc.clone(), s.workdir.clone(), s.model_name.clone()))
                })
            }
        };
        let Some((psid, ptc, workdir, model_name)) = claimed else { return false };
        let (title, prompt) = self
            .agent_inputs
            .lock()
            .unwrap()
            .get(&ptc)
            .cloned()
            .unwrap_or_else(|| ("子代理".into(), String::new()));
        self.sessions.lock().unwrap().insert(
            child_sid.to_string(),
            SessionState {
                seq: 0,
                running: true,
                created: true, // 壳侧会话,无引擎实体,open 不做 resume RPC
                engine_id: child_sid.to_string(),
                opened: false,
                open_tools: HashMap::new(),
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
        self.subagents.lock().unwrap().insert(
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
    fn subagent_feed(&self, child_sid: &str, etype: &str, event: &Value, data: &Value) {
        let Some((psid, ptc)) = self
            .subagents
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
                    let mut subs = self.subagents.lock().unwrap();
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

    /// 上下文占用 → usage 帧。上游 296176a 起:turn/stopped 带
    /// context:{used_tokens,window_tokens}(轮后整会话历史+系统提示的
    /// token 估计),session/create 结果带 context_used/context_window
    /// (resume 时立即可显示占用)。
    fn push_usage(&self, sid: &str, used: i64, window: i64) {
        if used > 0 && window > 0 {
            self.push_frame(sid, |seq| frame::usage_update(used, window, seq));
        }
    }

    /// 入站事件的壳会话反查(引擎 session_id → 壳 sid)。通常同名;
    /// 空会话重建换绑后不同。未命中原样返回(供子代理未知 id 认领)。
    fn shell_sid_of(&self, engine: &str) -> String {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(_, s)| s.engine_id == engine)
            .map(|(sid, _)| sid.clone())
            .unwrap_or_else(|| engine.to_string())
    }

    /// 关闭一个子会话:收尾帧 + sidecar 终态(不发 session-event,不惊动侧栏)。
    fn close_child(&self, child_sid: &str, status: SessionStatus) {
        let was = {
            let mut sessions = self.sessions.lock().unwrap();
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
    fn close_subagents_of(&self, sid: &str, tc_id: &str) {
        let closing: Vec<(String, String)> = {
            let mut subs = self.subagents.lock().unwrap();
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
        self.agent_inputs.lock().unwrap().remove(tc_id);
    }

    /// 会话轮次结束/和解:其子代理路由全部失效,残留子会话按 status 收尾。
    fn close_children_of_session(&self, sid: &str, status: SessionStatus) {
        let children: Vec<String> = {
            let mut subs = self.subagents.lock().unwrap();
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

    /// event/stream 事件归一化 → Frame。
    fn handle_event(&self, event: Value) {
        let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let raw = event.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
        if raw.is_empty() {
            return;
        }
        let sid = self.shell_sid_of(raw);
        let data = event.get("data").cloned().unwrap_or(Value::Null);
        // 未知 session_id = 上游转发的子代理事件(子循环随机 id):
        // 认领并物化为壳侧子会话,后续事件走正常帧路径;认领不到(迟到)丢弃
        if !self.sessions.lock().unwrap().contains_key(&sid) && !self.claim_subagent(&sid, &event) {
            return;
        }
        // 子代理事件在父卡进度窗同步一份内联预览(非子代理为 no-op)
        self.subagent_feed(&sid, etype, &event, &data);
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
                if !tc_id.is_empty() {
                    if let Some(s) = self.sessions.lock().unwrap().get_mut(&sid) {
                        s.open_tools.insert(tc_id.clone(), name.clone());
                    }
                    if name == "Agent" {
                        // 暂存入参:子会话物化时作标题(description)与首条输入(prompt)
                        let desc = input
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("子代理")
                            .to_string();
                        let prompt =
                            input.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        self.agent_inputs.lock().unwrap().insert(tc_id.clone(), (desc, prompt));
                    }
                }
                self.push_frame(&sid, |seq| frame::tool_call(&tc_id, &title, &input, seq));
            }
            "tool_result" => {
                let tc_id = event.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(s) = self.sessions.lock().unwrap().get_mut(&sid) {
                    s.open_tools.remove(&tc_id);
                }
                // Agent 工具闭合:清对应子代理路由(残留行缓冲先冲洗成尾行)
                self.close_subagents_of(&sid, &tc_id);
                // 错误收尾(b02fc77:错误也发 tool_result,约定 "Error: " 前缀,
                // 无独立错误位)→ failed 帧,否则失败工具渲染成绿勾
                if content.starts_with("Error: ") {
                    self.push_frame(&sid, |seq| frame::tool_call_failed(&tc_id, content, seq));
                } else {
                    // 结果文本里的工作区上传路径(浏览器截图等)→ 工具卡内联图
                    let images = extract_upload_paths(content);
                    self.push_frame(&sid, |seq| {
                        frame::tool_call_completed(&tc_id, content, &images, seq)
                    });
                }
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
/// 从工具结果文本提取工作区上传路径(.monkeycode/uploads/…):
/// 浏览器截图等壳内生成物经文本路径外显,驱动转成工具卡 images。
fn extract_upload_paths(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(i) = rest.find(".monkeycode/uploads/") {
        let tail = &rest[i..];
        let end = tail.find(|c: char| c.is_whitespace() || c == ')' || c == '"' || c == ',').unwrap_or(tail.len());
        let p = &tail[..end];
        if p.len() > ".monkeycode/uploads/".len() && !out.iter().any(|x| x == p) {
            out.push(p.to_string());
        }
        rest = &rest[i + end.max(1)..];
    }
    out
}

/// 壳模式词汇 → ohmyagent permission_mode
fn ohmy_mode_of(mode: &str) -> &'static str {
    if mode == "yolo" { "bypassPermissions" } else { "default" }
}

fn perm_title(tool: &str, input: &Value) -> String {
    // description 兜底:Agent/任务类工具的 3-5 词任务描述作卡片标签
    // (与引擎 TUI 的子代理活动面板同源,6a61cfd)
    let arg = ["file_path", "path", "command", "pattern", "url", "cwd", "description"]
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
/// 一次性迁移:接管时代写在 ~/.ohmyagent 的会话搬进私有目录
/// (仅当私有目录还没有 sessions;拷贝失败静默,最坏丢历史不丢功能)。
fn migrate_legacy_sessions(engine_dir: &std::path::Path) {
    let new_sessions = engine_dir.join("sessions");
    if new_sessions.exists() {
        return;
    }
    let Some(home) = crate::config::home_dir() else { return };
    let old_sessions = home.join(".ohmyagent").join("sessions");
    if !old_sessions.is_dir() {
        return;
    }
    fn copy_dir(src: &std::path::Path, dst: &std::path::Path) {
        let _ = std::fs::create_dir_all(dst);
        let Ok(entries) = std::fs::read_dir(src) else { return };
        for e in entries.flatten() {
            let (s, d) = (e.path(), dst.join(e.file_name()));
            if s.is_dir() {
                copy_dir(&s, &d);
            } else {
                let _ = std::fs::copy(&s, &d);
            }
        }
    }
    copy_dir(&old_sessions, &new_sessions);
    eprintln!("[mc-desktop] 已迁移 ~/.ohmyagent/sessions → {}", new_sessions.display());
}

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

    /// E2E 串行锁:两个 E2E 都改进程级 HOME/XDG 环境变量,并行会互踩
    static E2E_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn sse_event(name: &str, data: Value) -> String {
        format!("event: {name}\ndata: {data}")
    }

    fn sse_head() -> Vec<String> {
        vec![sse_event(
            "message_start",
            json!({"type":"message_start","message":{"id":"m1","role":"assistant","content":[],"model":"test-model","usage":{"input_tokens":10,"output_tokens":0}}}),
        )]
    }

    fn sse_tail(stop_reason: &str) -> Vec<String> {
        vec![
            sse_event("content_block_stop", json!({"type":"content_block_stop","index":0})),
            sse_event(
                "message_delta",
                json!({"type":"message_delta","delta":{"stop_reason":stop_reason},"usage":{"output_tokens":5}}),
            ),
            sse_event("message_stop", json!({"type":"message_stop"})),
        ]
    }

    /// 一段纯文本流式应答(end_turn)。
    fn sse_text(text: &str) -> String {
        let mut ev = sse_head();
        ev.push(sse_event(
            "content_block_start",
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        ));
        ev.push(sse_event(
            "content_block_delta",
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
        ));
        ev.extend(sse_tail("end_turn"));
        ev.join("\n\n") + "\n\n"
    }

    /// 一次工具调用流式应答(stop_reason=tool_use)。
    fn sse_tool_use(tu_id: &str, name: &str, input: &Value) -> String {
        let mut ev = sse_head();
        ev.push(sse_event(
            "content_block_start",
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":tu_id,"name":name,"input":{}}}),
        ));
        ev.push(sse_event(
            "content_block_delta",
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":input.to_string()}}),
        ));
        ev.extend(sse_tail("tool_use"));
        ev.join("\n\n") + "\n\n"
    }

    /// 假 Anthropic SSE 服务:按请求序回放 steps(超出重复最后一步);
    /// delay_ms > 0 时应答前挂起(模拟慢模型,测运行中停止的和解)。
    fn fake_anthropic_steps(delay_ms: u64, steps: Vec<String>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut conn) = conn else { continue };
                let n = counter.fetch_add(1, Ordering::Relaxed);
                let sse = steps[n.min(steps.len() - 1)].clone();
                std::thread::spawn(move || {
                    use std::io::{BufRead as _, Write as _};
                    if delay_ms > 0 {
                        std::thread::sleep(Duration::from_millis(delay_ms));
                    }
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
    struct TestCtx(PathBuf);
    impl ShellCtx for TestCtx {
        fn emit_json(&self, _event: &str, _payload: Value) {}
        fn config_dir(&self) -> Result<PathBuf, String> {
            Ok(self.0.clone())
        }
    }

    /// 隔离 HOME(ohmyagent 配置/会话)与壳配置目录,写配置并起驱动。
    /// 改进程级环境变量,须持 E2E_LOCK 后调用。
    fn e2e_setup(tag: &str, llm_delay_ms: u64) -> (OhmyDriver, PathBuf) {
        e2e_setup_steps(tag, llm_delay_ms, vec![sse_text("你好,任务完成")])
    }

    fn e2e_setup_steps(tag: &str, llm_delay_ms: u64, steps: Vec<String>) -> (OhmyDriver, PathBuf) {
        let home = std::env::temp_dir().join(format!("ohmy-e2e-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        // 引擎配置写进壳私有目录(driver 会以 OHMYAGENT_CONFIG_DIR 注入)
        std::fs::create_dir_all(home.join("shellcfg/ohmyagent")).unwrap();
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_CONFIG_HOME", home.join("xdg"));

        let llm = fake_anthropic_steps(llm_delay_ms, steps);
        let settings = json!({
            "default_model": "test-model",
            "permission_mode": "default",
            "providers": { "anthropic": { "api_key": "sk-fake", "base_url": format!("{llm}/api/anthropic") } },
            "models": [{ "id": "test-model", "provider": "anthropic", "context_window": 200000 }],
        });
        std::fs::write(
            home.join("shellcfg/ohmyagent/settings.json"),
            serde_json::to_vec_pretty(&settings).unwrap(),
        )
        .unwrap();

        let ctx: Arc<dyn ShellCtx> = Arc::new(TestCtx(home.join("shellcfg")));
        let cfg = DesktopConfig {
            models: json!([{ "name": "测试模型", "provider": "anthropic",
                "base_url": format!("{llm}/api/anthropic"), "api_key": "sk-fake", "model": "test-model", "default": true }]),
            ..Default::default()
        };
        let driver = OhmyDriver::start_with(ctx, &cfg).expect("引擎启动");
        (driver, home)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_chat_normalization() {
        if find_ohmyagent().is_none() {
            eprintln!("skip: 未找到 ohmyagent 二进制");
            return;
        }
        let _g = E2E_LOCK.lock().unwrap();
        let (driver, home) = e2e_setup("chat", 0);

        let workdir = home.to_string_lossy().into_owned();
        let meta = driver.session_create(&workdir, "测试模型", false).await.expect("建会话");
        // 契约 5:新建未运行的会话是 created(不是 finished)
        assert_eq!(meta.get("status").and_then(|v| v.as_str()), Some("created"));
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
        // 轮后上下文占用帧(turn/stopped.context,296176a):used>0,window=清单值
        let has_usage = journal
            .iter()
            .filter_map(|f| {
                if f.get("kind").and_then(|v| v.as_str()) != Some("acp_event") {
                    return None;
                }
                let data = f.get("data").and_then(|v| v.as_str())?;
                frame::b64_decode_json(data)?.get("update").cloned()
            })
            .any(|u| {
                u.get("sessionUpdate").and_then(|v| v.as_str()) == Some("usage_update")
                    && u.get("used").and_then(|v| v.as_i64()).unwrap_or(0) > 0
                    && u.get("size").and_then(|v| v.as_i64()) == Some(200000)
            });
        assert!(has_usage, "缺上下文占用帧: {journal:?}");
        // seq 单调
        let seqs: Vec<u64> = journal.iter().filter_map(|f| f.get("seq").and_then(|v| v.as_u64())).collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]), "seq 不单调: {seqs:?}");

        // 会话列表(sidecar 权威):标题取首条输入,状态 finished
        let list = driver.sessions_list().await.unwrap();
        let items = list.as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("status").and_then(|v| v.as_str()), Some("finished"));
        assert!(items[0].get("title").and_then(|v| v.as_str()).unwrap_or("").contains("hello world"));

        // session/switchMode、session/switchModel 通路(会话已激活,走原生 RPC)
        driver
            .session_call(&sid, "session_set_mode", json!({ "mode": "yolo" }))
            .await
            .expect("切权限模式");
        driver
            .session_call(&sid, "session_set_model", json!({ "model": "测试模型" }))
            .await
            .expect("切模型");

        driver.stop();
    }

    /// 运行中停止引擎必须本地和解:补收尾帧、sidecar 落 interrupted——
    /// 否则会话永久卡"执行中"(不能发/不能删/不能切,重启也救不回)。
    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_stop_reconciles_running_session() {
        if find_ohmyagent().is_none() {
            eprintln!("skip: 未找到 ohmyagent 二进制");
            return;
        }
        let _g = E2E_LOCK.lock().unwrap();
        // 慢速假 LLM(8s>stop 的 5s 优雅等待):轮次挂在模型调用上
        let (driver, home) = e2e_setup("stop", 8000);

        let workdir = home.to_string_lossy().into_owned();
        let meta = driver.session_create(&workdir, "测试模型", false).await.expect("建会话");
        let sid = meta.get("id").and_then(|v| v.as_str()).unwrap().to_string();
        driver.session_open(&sid).await.expect("打开会话");
        let payload = json!({ "content": frame::b64_text("会被挂住的任务") });
        driver.session_send(&sid, "user-input", payload).await.expect("发送");

        driver.stop();

        let journal = driver.read_journal(&sid);
        let types: Vec<&str> = journal.iter().filter_map(|f| f.get("type").and_then(|v| v.as_str())).collect();
        assert!(types.contains(&"task-started"), "缺 task-started: {types:?}");
        assert!(types.contains(&"task-error"), "停止未补 task-error: {types:?}");
        assert!(types.contains(&"task-ended"), "停止未补 task-ended: {types:?}");
        let meta = driver.0.read_sidecar(&sid);
        assert_eq!(
            meta.get("status").and_then(|v| v.as_str()),
            Some("interrupted"),
            "sidecar 未落 interrupted: {meta:?}"
        );
    }

    /// 轮询帧日志直到谓词命中(100ms × 150 = 15s 上限)。
    async fn wait_journal(driver: &OhmyDriver, sid: &str, pred: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let mut journal = vec![];
        for _ in 0..150 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            journal = driver.read_journal(sid);
            if pred(&journal) {
                break;
            }
        }
        journal
    }

    fn acp_update(f: &Value) -> Option<Value> {
        if f.get("kind").and_then(|v| v.as_str()) != Some("acp_event") {
            return None;
        }
        let data = f.get("data").and_then(|v| v.as_str())?;
        frame::b64_decode_json(data)?.get("update").cloned()
    }

    /// AskUserQuestion 全链路:deferred 工具经 ToolSearch 载入 → 引擎
    /// question/request → 壳 acp_ask_user_question 帧 → 答复 → 轮次完成。
    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_ask_user_question_flow() {
        if find_ohmyagent().is_none() {
            eprintln!("skip: 未找到 ohmyagent 二进制");
            return;
        }
        let _g = E2E_LOCK.lock().unwrap();
        let steps = vec![
            sse_tool_use("tu_1", "ToolSearch", &json!({ "query": "AskUserQuestion" })),
            sse_tool_use("tu_2", "AskUserQuestion", &json!({ "questions": [{
                "question": "选哪个?", "header": "选择",
                "options": [{"label":"A","description":"甲"},{"label":"B","description":"乙"}],
                "multiSelect": false }] })),
            sse_text("好的,按 A 处理"),
        ];
        let (driver, home) = e2e_setup_steps("ask", 0, steps);
        let workdir = home.to_string_lossy().into_owned();
        let meta = driver.session_create(&workdir, "测试模型", false).await.expect("建会话");
        let sid = meta.get("id").and_then(|v| v.as_str()).unwrap().to_string();
        driver.session_open(&sid).await.expect("打开会话");
        driver.session_call(&sid, "session_set_mode", json!({ "mode": "yolo" })).await.expect("yolo");
        driver
            .session_send(&sid, "user-input", json!({ "content": frame::b64_text("问我一个问题") }))
            .await
            .expect("发送");

        // 提问卡帧落日志,取 request_id
        let journal = wait_journal(&driver, &sid, |j| {
            j.iter().any(|f| f.get("kind").and_then(|v| v.as_str()) == Some("acp_ask_user_question"))
        })
        .await;
        let req_id = journal
            .iter()
            .filter(|f| f.get("kind").and_then(|v| v.as_str()) == Some("acp_ask_user_question"))
            .filter_map(|f| f.get("data").and_then(|v| v.as_str()).and_then(frame::b64_decode_json))
            .filter_map(|v| {
                v.get("toolCall")
                    .and_then(|t| t.get("toolCallId"))
                    .and_then(|i| i.as_str())
                    .map(String::from)
            })
            .next()
            .unwrap_or_default();
        assert!(!req_id.is_empty(), "未收到提问卡帧,journal: {journal:?}");

        // 答复 → 轮次完成,答案回显帧在日志(回放可见)
        driver
            .session_send(
                &sid,
                "reply-question",
                json!({ "request_id": req_id, "answers_json": "{\"选哪个?\":\"A\"}", "cancelled": false }),
            )
            .await
            .expect("答复");
        let journal = wait_journal(&driver, &sid, |j| {
            j.iter().any(|f| f.get("type").and_then(|v| v.as_str()) == Some("task-ended"))
        })
        .await;
        let types: Vec<&str> =
            journal.iter().filter_map(|f| f.get("type").and_then(|v| v.as_str())).collect();
        assert!(types.contains(&"reply-question"), "缺答案回显帧: {types:?}");
        assert!(types.contains(&"task-ended"), "轮次未完成: {types:?}");
        driver.stop();
    }

    /// SubAgent 进度:上游转发的子循环事件(未知随机 session_id)被认领到
    /// 父会话,归一化为 Agent 工具卡的 progress feed(subagent_text 行)。
    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_subagent_progress() {
        if find_ohmyagent().is_none() {
            eprintln!("skip: 未找到 ohmyagent 二进制");
            return;
        }
        let _g = E2E_LOCK.lock().unwrap();
        let steps = vec![
            sse_tool_use("tu_1", "Agent", &json!({ "prompt": "调查并汇报", "description": "调查任务" })),
            sse_text("子代理调查结果:一切正常\n"),
            sse_text("父任务完成"),
        ];
        let (driver, home) = e2e_setup_steps("sub", 0, steps);
        let workdir = home.to_string_lossy().into_owned();
        let meta = driver.session_create(&workdir, "测试模型", false).await.expect("建会话");
        let sid = meta.get("id").and_then(|v| v.as_str()).unwrap().to_string();
        driver.session_open(&sid).await.expect("打开会话");
        driver.session_call(&sid, "session_set_mode", json!({ "mode": "yolo" })).await.expect("yolo");
        driver
            .session_send(&sid, "user-input", json!({ "content": frame::b64_text("派个子代理") }))
            .await
            .expect("发送");

        let journal = wait_journal(&driver, &sid, |j| {
            j.iter().any(|f| f.get("type").and_then(|v| v.as_str()) == Some("task-ended"))
        })
        .await;
        // Agent 工具卡存在且完成;标题带 description 标签(TUI 面板同源)
        let agent_done = journal.iter().filter_map(acp_update).any(|u| {
            u.get("sessionUpdate").and_then(|v| v.as_str()) == Some("tool_call_update")
                && u.get("toolCallId").and_then(|v| v.as_str()) == Some("tu_1")
                && u.get("status").and_then(|v| v.as_str()) == Some("completed")
        });
        assert!(agent_done, "Agent 工具未完成: {journal:?}");
        let agent_titled = journal.iter().filter_map(acp_update).any(|u| {
            u.get("sessionUpdate").and_then(|v| v.as_str()) == Some("tool_call")
                && u.get("toolCallId").and_then(|v| v.as_str()) == Some("tu_1")
                && u.get("title").and_then(|v| v.as_str()).map(|t| t.contains("调查任务")).unwrap_or(false)
        });
        assert!(agent_titled, "Agent 卡标题缺 description 标签: {journal:?}");
        // 子代理文本行以 progress feed 形态挂在 Agent 工具卡上
        let has_sub_text = journal.iter().filter_map(acp_update).any(|u| {
            u.get("toolCallId").and_then(|v| v.as_str()) == Some("tu_1")
                && u.get("progress").and_then(|p| p.get("kind")).and_then(|v| v.as_str())
                    == Some("subagent_text")
                && u.get("progress")
                    .and_then(|p| p.get("line"))
                    .and_then(|v| v.as_str())
                    .map(|l| l.contains("子代理调查结果"))
                    .unwrap_or(false)
        });
        assert!(has_sub_text, "缺子代理进度行: {journal:?}");
        // 子会话物化:父卡有 child_session 链接,子 journal 形状完整可回放
        let child_id = journal
            .iter()
            .filter_map(acp_update)
            .find_map(|u| {
                if u.get("toolCallId").and_then(|v| v.as_str()) != Some("tu_1") {
                    return None;
                }
                let p = u.get("progress")?;
                if p.get("kind").and_then(|v| v.as_str()) != Some("child_session") {
                    return None;
                }
                p.get("childSessionId").and_then(|v| v.as_str()).map(String::from)
            })
            .expect("缺 child_session 链接");
        let ctypes: Vec<String> = driver
            .read_journal(&child_id)
            .iter()
            .filter_map(|f| f.get("type").and_then(|v| v.as_str()).map(String::from))
            .collect();
        for t in ["user-input", "task-started", "task-ended"] {
            assert!(ctypes.iter().any(|x| x == t), "子会话缺 {t}: {ctypes:?}");
        }
        // 子会话不进会话列表(经父卡点开,与 mc-agent 一致)
        let list = driver.sessions_list().await.unwrap();
        assert!(
            list.as_array()
                .unwrap()
                .iter()
                .all(|s| s.get("id").and_then(|v| v.as_str()) != Some(child_id.as_str())),
            "子会话不应出现在列表"
        );
        driver.stop();
    }
}
