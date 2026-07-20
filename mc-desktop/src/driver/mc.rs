// McAgentDriver:拉起 mc-agent serve(headless)并作为其唯一客户端。
//
// - REST:会话管理/模型清单(壳→内核,Bearer token)
// - WS:每个打开的会话一条连接,下行帧原样透传(已是 Frame 词汇)到
//   `frames:{sid}` 事件;上行 user-input/user-cancel/permission-resp/
//   reply-question 帧与 call(session_set_model/mode)
// - SSE:/api/events 全局状态转发为 `session-event` 事件(侧栏+桌宠)
// - 内核 HTTP 代理:仅浏览器扩展桥(/api/browser/*)
//
// 内核进程管理沿用原壳逻辑:配置经环境变量注入(不走 argv,避免泄漏进
// ps);壳持有内核 stdin 管道(--watch-stdin 契约),壳以任何方式退出内核
// 随之退出;WSL 模式经 wsl.exe 在发行版内拉起 Linux 内核。

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex as TokioMutex};
use tokio_tungstenite::tungstenite::Message;

use super::frame::{b64_decode_json, b64_json, now_ms};
use crate::config::{DesktopConfig, KernelFiles};
use crate::wsl;

const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const RECONNECT_DELAY: Duration = Duration::from_secs(2);
const FRAME_FLUSH_MS: u64 = 30;

#[derive(Clone)]
pub struct McDriver(Arc<Inner>);

struct Inner {
    app: AppHandle,
    port: u16,
    token: String,
    wsl_distro: Option<String>,
    http: reqwest::Client,
    child: StdMutex<Option<Child>>,
    /// 打开中的会话流(sid → 上行通道)
    sessions: TokioMutex<HashMap<String, SessionConn>>,
    /// 会话工作区缓存(repo/uploads 定位;list/create 时回填)
    workdirs: StdMutex<HashMap<String, String>>,
    /// 会话连接代际计数(见 SessionConn::epoch)
    conn_epoch: std::sync::atomic::AtomicU64,
    /// 引擎停止标志(所有后台任务检查退出)
    stopped: Arc<AtomicBool>,
}

struct SessionConn {
    tx: mpsc::UnboundedSender<OutMsg>,
    closed: Arc<AtomicBool>,
    /// 连接代际:同一会话快速 close→reopen 时,旧 ws 循环退出清理只许
    /// 移除自己那一代的条目,不许误删新连接(否则新会话流静默死亡)
    epoch: u64,
}

enum OutMsg {
    /// 上行帧(已编码完整 Frame JSON 文本)
    Frame(String),
    /// call 请求:发出后按 kind FIFO 等应答(载荷已 base64 解码为 {result}/{error})
    Call { kind: String, frame: String, resp: oneshot::Sender<Value> },
}

impl McDriver {
    // ==================== 生命周期 ====================

    /// 启动内核并等待就绪(阻塞至多 15/30s,沿用原 start_kernel 语义)。
    pub fn start(app: AppHandle, cfg: &DesktopConfig, files: &KernelFiles) -> Result<Self, String> {
        let wsl_distro = wsl::distro_of(&cfg.kernel_env).map(str::to_string);
        let port = free_port().map_err(|e| format!("获取空闲端口失败: {e}"))?;
        let token = rand_token();
        let addr = format!("127.0.0.1:{port}");
        let serve_args = [
            "serve", "--addr", addr.as_str(), "--token", token.as_str(), "--watch-stdin",
        ];

        // 内核 stdout/stderr 落盘:GUI 壳没有控制台,不落盘的话内核 panic/报错
        // 文本直接丢失,"exit code: N" 无从诊断。每次启动截断重写。
        let log_path = crate::config::config_dir(&app)?.join("kernel.log");
        let log_out = fs::File::create(&log_path).ok();
        let log_err = log_out.as_ref().and_then(|f| f.try_clone().ok());

        let (mut cmd, bin_desc, ready_secs) = if let Some(distro) = &wsl_distro {
            let bin = find_agent_linux(&app).ok_or_else(|| {
                "找不到 mc-agent-linux(WSL 内核;查找顺序: MC_AGENT_LINUX_BIN 环境变量 → 应用资源目录 → 应用同目录)".to_string()
            })?;
            // 一次调用完成 VM 预热 + 发行版健康检查 + 三个路径的 Windows→Linux 翻译
            let paths = wsl::prepare(distro, &[&bin, &files.models, &files.mcp])?;
            let mut cmd = Command::new(wsl::wsl_exe());
            cmd.args(["-d", distro, "--exec", &paths[0]])
                .args(serve_args)
                .env("MC_AGENT_MODELS", &paths[1])
                .env("MC_AGENT_MCP_CONFIG", &paths[2])
                // wsl.exe 不透传任意环境变量,须经 WSLENV 白名单;
                // 值已是 Linux 路径,/u = 仅 Win→WSL 方向、不再做路径翻译
                .env("WSLENV", "MC_AGENT_MODELS/u:MC_AGENT_MCP_CONFIG/u");
            (cmd, format!("wsl:{distro} {}", paths[0]), 30u64)
        } else {
            let bin = find_agent().ok_or_else(|| {
                "找不到 mc-agent 可执行文件(查找顺序: MC_AGENT_BIN 环境变量 → 应用同目录 → PATH)".to_string()
            })?;
            let mut cmd = Command::new(&bin);
            // 进程 cwd 定在主目录(与 ohmy 驱动一致):打包应用启动时壳 cwd
            // 是 "/",不给内核与其子进程漏一个不可写的工作目录
            if let Some(home) = crate::config::home_dir() {
                cmd.current_dir(home);
            }
            cmd.args(serve_args)
                .env("MC_AGENT_MODELS", &files.models)
                .env("MC_AGENT_MCP_CONFIG", &files.mcp);
            (cmd, bin.display().to_string(), 15u64)
        };
        cmd.stdin(Stdio::piped())
            .stdout(log_out.map(Stdio::from).unwrap_or_else(Stdio::inherit))
            .stderr(log_err.map(Stdio::from).unwrap_or_else(Stdio::inherit));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("启动内核失败({bin_desc}): {e}"))?;

        // 等待内核就绪(端口可连接);失败时带上退出状态与日志尾部
        let deadline = Instant::now() + Duration::from_secs(ready_secs);
        loop {
            if TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(200)).is_ok() {
                break;
            }
            if let Ok(Some(status)) = child.try_wait() {
                let tail = fs::read(&log_path)
                    .map(|b| {
                        let s = wsl::decode_wsl_output(&b);
                        let lines: Vec<_> = s.lines().collect();
                        lines[lines.len().saturating_sub(15)..].join("\n")
                    })
                    .unwrap_or_default();
                return Err(format!(
                    "内核进程提前退出({status})。日志({}):\n{}",
                    log_path.display(),
                    if tail.is_empty() { "(空)" } else { &tail }
                ));
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let mut msg = format!("内核在 {ready_secs} 秒内未就绪");
                if let Some(distro) = &wsl_distro {
                    let args: Vec<String> =
                        ["-d", distro, "--exec", "pkill", "-x", "mc-agent-linux"].map(String::from).into();
                    let _ = wsl::run_wsl(&args, Duration::from_secs(5));
                    msg.push_str(&format!(
                        "。WSL 模式排查:确认 {distro} 为 WSL2 且未在 .wslconfig 中关闭 \
                         localhostForwarding;系统睡眠恢复后异常可先执行 `wsl --shutdown` 再重启应用"
                    ));
                }
                return Err(msg);
            }
            std::thread::sleep(Duration::from_millis(150));
        }

        eprintln!("[mc-desktop] 内核就绪: 127.0.0.1:{port}");
        let driver = McDriver(Arc::new(Inner {
            app,
            port,
            token,
            wsl_distro,
            http: reqwest::Client::new(),
            child: StdMutex::new(Some(child)),
            sessions: TokioMutex::new(HashMap::new()),
            workdirs: StdMutex::new(HashMap::new()),
            conn_epoch: std::sync::atomic::AtomicU64::new(1),
            stopped: Arc::new(AtomicBool::new(false)),
        }));
        driver.spawn_sse();
        driver.spawn_exit_watch(log_path);
        Ok(driver)
    }

    /// 内核进程退出监视:非 stop() 引发的退出 = 崩溃,发 engine-crashed
    /// 事件(带日志尾)让 UI 外显并提供一键重启——否则 WS/SSE 只会无限
    /// 重连,用户视角就是卡死。
    fn spawn_exit_watch(&self, log_path: std::path::PathBuf) {
        let inner = self.0.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if inner.stopped.load(Ordering::Relaxed) {
                    return;
                }
                let exited = {
                    let mut child = inner.child.lock().unwrap();
                    match child.as_mut() {
                        // stop() 已取走 = 正常关停
                        None => return,
                        Some(c) => c.try_wait().ok().flatten(),
                    }
                };
                if let Some(status) = exited {
                    if inner.stopped.load(Ordering::Relaxed) {
                        return;
                    }
                    inner.child.lock().unwrap().take();
                    let tail = super::log_tail(&log_path, 15);
                    eprintln!("[mc-desktop] 内核异常退出({status})");
                    let _ = inner.app.emit(
                        "engine-crashed",
                        json!({ "engine": "mc-agent", "detail": format!("内核进程异常退出({status})"), "log_tail": tail }),
                    );
                    return;
                }
            }
        });
    }

    /// 停止:关 stdin 管道触发内核优雅退出(--watch-stdin 契约:内核取消
    /// 进行中的轮次并落盘会话消息快照),超时未退再强杀兜底。
    /// 不可直接 kill:messages.json(模型上下文)只在轮次收尾落盘。
    pub fn stop(&self) {
        self.0.stopped.store(true, Ordering::Relaxed);
        let Some(mut child) = self.0.child.lock().unwrap().take() else {
            return;
        };
        drop(child.stdin.take());
        // 内核侧收尾预算:取消轮次等待 3s + HTTP 优雅关闭 3s,留足余量
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        eprintln!("[mc-desktop] 内核未在期限内优雅退出,强制终止");
        let _ = child.kill();
        let _ = child.wait();
        if let Some(d) = &self.0.wsl_distro {
            let args: Vec<String> =
                ["-d", d.as_str(), "--exec", "pkill", "-x", "mc-agent-linux"].map(String::from).into();
            let _ = wsl::run_wsl(&args, Duration::from_secs(5));
        }
    }

    pub fn wsl_distro(&self) -> Option<String> {
        self.0.wsl_distro.clone()
    }

    // ==================== REST ====================

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.0.port, path)
    }

    async fn rest(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| format!("非法方法 {method}"))?;
        let mut req = self.0.http.request(m, self.url(path)).bearer_auth(&self.0.token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await.map_err(|e| format!("内核请求失败: {e}"))?;
        let status = resp.status();
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let msg = v
                .get("error")
                .and_then(|e| e.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
            return Err(msg);
        }
        Ok(v)
    }

    fn cache_workdirs(&self, v: &Value) {
        let mut cache = self.0.workdirs.lock().unwrap();
        let mut put = |m: &Value| {
            if let (Some(id), Some(wd)) = (
                m.get("id").and_then(|x| x.as_str()),
                m.get("workdir").and_then(|x| x.as_str()),
            ) {
                cache.insert(id.to_string(), wd.to_string());
            }
        };
        match v {
            Value::Array(items) => items.iter().for_each(&mut put),
            m => put(m),
        }
    }

    pub async fn sessions_list(&self) -> Result<Value, String> {
        let v = self.rest("GET", "/api/sessions", None).await?;
        self.cache_workdirs(&v);
        Ok(v)
    }

    pub async fn session_create(&self, workdir: &str, model: &str, create_dir: bool) -> Result<Value, String> {
        let v = self
            .rest(
                "POST",
                "/api/sessions",
                Some(json!({ "workdir": workdir, "model": model, "create_dir": create_dir })),
            )
            .await?;
        self.cache_workdirs(&v);
        Ok(v)
    }

    pub async fn session_delete(&self, id: &str) -> Result<Value, String> {
        self.rest("DELETE", &format!("/api/sessions/{id}"), None).await
    }

    pub async fn session_patch(&self, id: &str, patch: Value) -> Result<Value, String> {
        self.rest("PATCH", &format!("/api/sessions/{id}"), Some(patch)).await
    }

    pub async fn models_list(&self) -> Result<Value, String> {
        self.rest("GET", "/api/models", None).await
    }

    pub async fn session_workdir(&self, id: &str) -> Result<String, String> {
        if let Some(wd) = self.0.workdirs.lock().unwrap().get(id).cloned() {
            return Ok(wd);
        }
        // 缓存未命中(如壳重启后直接打开历史会话):拉全量列表回填。
        // 子代理的子会话不在默认列表,带 all=1。
        let v = self.rest("GET", "/api/sessions?all=1", None).await?;
        self.cache_workdirs(&v);
        self.0
            .workdirs
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("会话 {id} 不存在"))
    }

    /// 内核 HTTP 代理(浏览器扩展桥专用;路径白名单在命令层)。返回 {status, body}。
    pub async fn kernel_http(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        if !path.starts_with("/api/") {
            return Err("仅允许 /api/ 路径".into());
        }
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| format!("非法方法 {method}"))?;
        let mut req = self.0.http.request(m, self.url(path)).bearer_auth(&self.0.token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await.map_err(|e| format!("内核请求失败: {e}"))?;
        let status = resp.status().as_u16();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        Ok(json!({ "status": status, "body": body }))
    }

    // ==================== SSE(全局会话状态) ====================

    /// 订阅内核 /api/events 并转发为全局 `session-event` 事件;断线 3s 重连。
    fn spawn_sse(&self) {
        let inner = self.0.clone();
        tauri::async_runtime::spawn(async move {
            while !inner.stopped.load(Ordering::Relaxed) {
                let url = format!("http://127.0.0.1:{}/api/events", inner.port);
                let resp = inner.http.get(&url).bearer_auth(&inner.token).send().await;
                if let Ok(resp) = resp {
                    let mut stream = resp.bytes_stream();
                    let mut buf = String::new();
                    while let Some(chunk) = stream.next().await {
                        if inner.stopped.load(Ordering::Relaxed) {
                            return;
                        }
                        let Ok(chunk) = chunk else { break };
                        buf.push_str(&String::from_utf8_lossy(&chunk));
                        // SSE 帧以空行分隔;逐条取 data: 行
                        while let Some(pos) = buf.find("\n\n") {
                            let evt: String = buf[..pos].to_string();
                            buf = buf[pos + 2..].to_string();
                            for line in evt.lines() {
                                if let Some(data) = line.strip_prefix("data: ") {
                                    if let Ok(v) = serde_json::from_str::<Value>(data) {
                                        let _ = inner.app.emit("session-event", v);
                                    }
                                }
                            }
                        }
                    }
                }
                if inner.stopped.load(Ordering::Relaxed) {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        });
    }

    // ==================== 会话 WS ====================

    pub async fn session_open(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.0.sessions.lock().await;
        if sessions.contains_key(id) {
            return Ok(()); // 幂等:已打开
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let closed = Arc::new(AtomicBool::new(false));
        let epoch = self.0.conn_epoch.fetch_add(1, Ordering::Relaxed);
        sessions.insert(id.to_string(), SessionConn { tx, closed: closed.clone(), epoch });
        drop(sessions);

        let inner = self.0.clone();
        let sid = id.to_string();
        tauri::async_runtime::spawn(session_ws_loop(inner, sid, rx, closed, epoch));
        Ok(())
    }

    pub async fn session_close(&self, id: &str) {
        if let Some(conn) = self.0.sessions.lock().await.remove(id) {
            conn.closed.store(true, Ordering::Relaxed);
            // tx drop → 写循环感知退出
        }
    }

    pub async fn session_send(&self, id: &str, ftype: &str, payload: Value) -> Result<(), String> {
        let frame = json!({ "type": ftype, "data": b64_json(&payload), "timestamp": now_ms() }).to_string();
        let sessions = self.0.sessions.lock().await;
        let conn = sessions.get(id).ok_or_else(|| "会话流未打开".to_string())?;
        conn.tx.send(OutMsg::Frame(frame)).map_err(|_| "连接已断开,操作未发送".to_string())
    }

    pub async fn session_call(&self, id: &str, kind: &str, payload: Value) -> Result<Value, String> {
        let frame = json!({ "type": "call", "kind": kind, "data": b64_json(&payload), "timestamp": now_ms() })
            .to_string();
        let (resp_tx, resp_rx) = oneshot::channel();
        {
            let sessions = self.0.sessions.lock().await;
            let conn = sessions.get(id).ok_or_else(|| "会话流未打开".to_string())?;
            conn.tx
                .send(OutMsg::Call { kind: kind.to_string(), frame, resp: resp_tx })
                .map_err(|_| "连接已断开".to_string())?;
        }
        match tokio::time::timeout(CALL_TIMEOUT, resp_rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => Err("连接断开,请重试".into()),
            Err(_) => Err("call 超时".into()),
        }
    }

}

/// 会话 WS 主循环:连接→透传→断线重连(2s),closed 置位后退出。
/// 重连后内核整体回放事件日志(与原 UI 直连行为一致)。
async fn session_ws_loop(
    inner: Arc<Inner>,
    sid: String,
    mut out_rx: mpsc::UnboundedReceiver<OutMsg>,
    closed: Arc<AtomicBool>,
    epoch: u64,
) {
    let status_evt = format!("conn-status:{sid}");
    let frames_evt = format!("frames:{sid}");
    let url = format!("ws://127.0.0.1:{}/ws?session={}&token={}", inner.port, sid, inner.token);

    'reconnect: loop {
        if closed.load(Ordering::Relaxed) || inner.stopped.load(Ordering::Relaxed) {
            break;
        }
        let _ = inner.app.emit_to("main", &status_evt, json!({ "text": "连接中…", "connected": false }));
        let ws = match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => ws,
            Err(e) => {
                let _ = inner.app.emit_to(
                    "main",
                    &status_evt,
                    json!({ "text": format!("⚠ 连接失败({e}),2 秒后自动重连…"), "connected": false }),
                );
                tokio::time::sleep(RECONNECT_DELAY).await;
                continue;
            }
        };
        let _ = inner.app.emit_to("main", &status_evt, json!({ "text": "已连接", "connected": true }));

        let (mut sink, mut stream) = ws.split();
        // call 应答按 kind FIFO 配对(协议无请求 ID;服务端按帧序处理)
        let mut pending: HashMap<String, VecDeque<oneshot::Sender<Value>>> = HashMap::new();
        let mut batch: Vec<Value> = Vec::new();
        let mut flush = tokio::time::interval(Duration::from_millis(FRAME_FLUSH_MS));
        flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                _ = flush.tick() => {
                    if !batch.is_empty() {
                        let _ = inner.app.emit_to("main", &frames_evt, std::mem::take(&mut batch));
                    }
                }
                msg = out_rx.recv() => match msg {
                    Some(OutMsg::Frame(t)) => {
                        if sink.send(Message::Text(t.into())).await.is_err() {
                            continue 'reconnect;
                        }
                    }
                    Some(OutMsg::Call { kind, frame, resp }) => {
                        if sink.send(Message::Text(frame.into())).await.is_err() {
                            // resp 丢弃 → 调用方收到"连接断开"
                            continue 'reconnect;
                        }
                        pending.entry(kind).or_default().push_back(resp);
                    }
                    None => break 'reconnect, // 会话关闭
                },
                msg = stream.next() => match msg {
                    Some(Ok(Message::Text(t))) => {
                        let Ok(f) = serde_json::from_str::<Value>(&t) else { continue };
                        let ftype = f.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if ftype == "ping" {
                            continue;
                        }
                        if ftype == "call-response" {
                            let kind = f.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                            if let Some(q) = pending.get_mut(kind) {
                                if let Some(resp) = q.pop_front() {
                                    let payload = f
                                        .get("data")
                                        .and_then(|d| d.as_str())
                                        .and_then(b64_decode_json)
                                        .unwrap_or_else(|| json!({}));
                                    let _ = resp.send(payload); // 接收方已超时丢弃时为空操作
                                    continue;
                                }
                            }
                            // 无在等的 call(超时墓碑已由 oneshot 丢弃承担):透传给 UI 也无意义,丢弃
                            continue;
                        }
                        batch.push(f);
                    }
                    Some(Ok(_)) => {}
                    _ => {
                        // 断线:清掉在途 call(应答不会再来),2s 后重连,内核会整体回放
                        pending.clear();
                        let _ = inner.app.emit_to(
                            "main",
                            &status_evt,
                            json!({ "text": "⚠ 连接断开,2 秒后自动重连…", "connected": false }),
                        );
                        tokio::time::sleep(RECONNECT_DELAY).await;
                        continue 'reconnect;
                    }
                },
            }
        }
    }
    // 只清理自己这一代的条目:会话可能已被 close→reopen 换上新连接
    let mut sessions = inner.sessions.lock().await;
    if sessions.get(&sid).map(|c| c.epoch) == Some(epoch) {
        sessions.remove(&sid);
    }
}

// ==================== 内核二进制定位 ====================

/// 查找内核二进制:MC_AGENT_BIN → 应用同目录 → PATH(含 ~/.local/bin)。
fn find_agent() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MC_AGENT_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let name = if cfg!(windows) { "mc-agent.exe" } else { "mc-agent" };
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

/// 查找 Linux 内核二进制(WSL 模式;随 Windows 包以资源分发,经 /mnt/c 在
/// WSL 内直接执行,无需拷入发行版):MC_AGENT_LINUX_BIN → 资源目录 → 应用同目录。
fn find_agent_linux(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    if let Ok(p) = std::env::var("MC_AGENT_LINUX_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(p) = app.path().resolve("mc-agent-linux", tauri::path::BaseDirectory::Resource) {
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("mc-agent-linux");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn rand_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("getrandom");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
