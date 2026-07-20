// 引擎驱动层:UI 只经 Tauri IPC 与壳对话,壳内按配置适配不同 agent 内核。
//
// 下行帧统一走 Tauri 事件(UI 按会话订阅 `frames:{sid}`,帧为 mc-agent
// Frame 词汇——ohmyagent 引擎在 driver 内归一化,reduce 层零改动):
//   frames:{sid}       Frame[](~30ms 批量,防高频 delta 拖垮 IPC)
//   conn-status:{sid}  {text, connected} 会话流连接状态
//   session-event      {type: session-status|session-ask, ...} 全局状态(侧栏+桌宠)
//   ws-msg:{pipe}      云端 WS 桥下行文本帧(协议逻辑仍在 UI,壳只做管道)
//   ws-closed:{pipe}   云端 WS 桥断开
//
// 上行统一走 invoke 命令(本文件底部,main.rs 注册)。

pub mod mc;
pub mod ohmy;

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::config::DesktopConfig;
use crate::repo::RepoCtx;

/// 当前引擎(壳生命周期内至多一个;保存设置时整体替换)。
/// 内层是廉价克隆的句柄:命令先克隆再 await,不跨 await 持锁。
pub struct DriverHost(pub Mutex<Option<Engine>>);

impl DriverHost {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn get(&self) -> Result<Engine, String> {
        self.0.lock().unwrap().clone().ok_or_else(|| "引擎未运行".to_string())
    }

    pub fn running(&self) -> bool {
        self.0.lock().unwrap().is_some()
    }

    pub fn set(&self, e: Engine) {
        *self.0.lock().unwrap() = Some(e);
    }

    pub fn take(&self) -> Option<Engine> {
        self.0.lock().unwrap().take()
    }
}

#[derive(Clone)]
pub enum Engine {
    Mc(mc::McDriver),
    Ohmy(ohmy::OhmyDriver),
}

impl Engine {
    /// 停止引擎并回收内核进程(阻塞至多 ~10s,调用方按需 spawn_blocking)。
    pub fn stop(&self) {
        match self {
            Engine::Mc(d) => d.stop(),
            Engine::Ohmy(d) => d.stop(),
        }
    }

    /// 引擎能力(UI 按此降级:ohmyagent 无用量条/浏览器扩展/worktree 等)。
    pub fn caps(&self) -> Value {
        match self {
            Engine::Mc(_) => json!({
                "engine": "mc-agent",
                "browser_ext": true,
                "worktree": true,
                "usage_update": true,
                "perm_remember": true,
                "attachments": true,
            }),
            // browser_ext/worktree/usage_update 是 mc-agent 特有能力,UI 按此降级
            Engine::Ohmy(_) => json!({
                "engine": "ohmyagent",
                "browser_ext": false,
                "worktree": false,
                "usage_update": false,
                "perm_remember": true,
                "attachments": true,
            }),
        }
    }

    pub async fn sessions_list(&self) -> Result<Value, String> {
        match self {
            Engine::Mc(d) => d.sessions_list().await,
            Engine::Ohmy(d) => d.sessions_list().await,
        }
    }

    pub async fn session_create(&self, workdir: &str, model: &str, create_dir: bool) -> Result<Value, String> {
        match self {
            Engine::Mc(d) => d.session_create(workdir, model, create_dir).await,
            // ohmyagent 不展开 ~/不建目录,driver 内补齐(默认工作区 ~/MonkeyCode 依赖它)
            Engine::Ohmy(d) => d.session_create(workdir, model, create_dir).await,
        }
    }

    pub async fn session_delete(&self, id: &str) -> Result<Value, String> {
        match self {
            Engine::Mc(d) => d.session_delete(id).await,
            Engine::Ohmy(d) => d.session_delete(id).await,
        }
    }

    pub async fn session_patch(&self, id: &str, patch: Value) -> Result<Value, String> {
        match self {
            Engine::Mc(d) => d.session_patch(id, patch).await,
            Engine::Ohmy(d) => d.session_patch(id, patch).await,
        }
    }

    pub async fn models_list(&self) -> Result<Value, String> {
        match self {
            Engine::Mc(d) => d.models_list().await,
            Engine::Ohmy(d) => d.models_list().await,
        }
    }

    pub async fn session_open(&self, id: &str) -> Result<(), String> {
        match self {
            Engine::Mc(d) => d.session_open(id).await,
            Engine::Ohmy(d) => d.session_open(id).await,
        }
    }

    pub async fn session_close(&self, id: &str) {
        match self {
            Engine::Mc(d) => d.session_close(id).await,
            Engine::Ohmy(d) => d.session_close(id).await,
        }
    }

    pub async fn session_send(&self, id: &str, ftype: &str, payload: Value) -> Result<(), String> {
        match self {
            Engine::Mc(d) => d.session_send(id, ftype, payload).await,
            Engine::Ohmy(d) => d.session_send(id, ftype, payload).await,
        }
    }

    pub async fn session_call(&self, id: &str, kind: &str, payload: Value) -> Result<Value, String> {
        match self {
            Engine::Mc(d) => d.session_call(id, kind, payload).await,
            Engine::Ohmy(d) => d.session_call(id, kind, payload).await,
        }
    }

    /// 会话工作区(repo 浏览/上传定位用;worktree 会话已指向 worktree 路径)。
    pub async fn session_workdir(&self, id: &str) -> Result<String, String> {
        match self {
            Engine::Mc(d) => d.session_workdir(id).await,
            Engine::Ohmy(d) => d.session_workdir(id).await,
        }
    }

    pub fn wsl_distro(&self) -> Option<String> {
        match self {
            Engine::Mc(d) => d.wsl_distro(),
            Engine::Ohmy(_) => None,
        }
    }

    pub async fn kernel_http(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        match self {
            Engine::Mc(d) => d.kernel_http(method, path, body).await,
            Engine::Ohmy(_) => Err("ohmyagent 引擎无浏览器扩展桥".into()),
        }
    }
}

/// 按配置启动引擎(阻塞等就绪;setup 与 save_config 共用)。
pub fn start_engine(app: &AppHandle, cfg: &DesktopConfig, files: &crate::config::KernelFiles) -> Result<Engine, String> {
    match cfg.agent_engine.as_str() {
        "" | "mc-agent" => Ok(Engine::Mc(mc::McDriver::start(app.clone(), cfg, files)?)),
        "ohmyagent" => Ok(Engine::Ohmy(ohmy::OhmyDriver::start(app.clone(), cfg)?)),
        other => Err(format!("未知 agent 引擎 {other:?}(支持 mc-agent / ohmyagent)")),
    }
}

// ==================== Tauri 命令 ====================

#[tauri::command]
pub async fn engine_caps(host: State<'_, DriverHost>) -> Result<Value, String> {
    Ok(host.get()?.caps())
}

#[tauri::command]
pub async fn sessions_list(host: State<'_, DriverHost>) -> Result<Value, String> {
    host.get()?.sessions_list().await
}

#[tauri::command]
pub async fn session_create(
    host: State<'_, DriverHost>,
    workdir: String,
    model: String,
    create_dir: bool,
) -> Result<Value, String> {
    host.get()?.session_create(&workdir, &model, create_dir).await
}

#[tauri::command]
pub async fn session_delete(host: State<'_, DriverHost>, id: String) -> Result<Value, String> {
    host.get()?.session_delete(&id).await
}

#[tauri::command]
pub async fn session_patch(host: State<'_, DriverHost>, id: String, patch: Value) -> Result<Value, String> {
    host.get()?.session_patch(&id, patch).await
}

#[tauri::command]
pub async fn models_list(host: State<'_, DriverHost>) -> Result<Value, String> {
    host.get()?.models_list().await
}

#[tauri::command]
pub async fn session_open(host: State<'_, DriverHost>, id: String) -> Result<(), String> {
    host.get()?.session_open(&id).await
}

#[tauri::command]
pub async fn session_close(host: State<'_, DriverHost>, id: String) -> Result<(), String> {
    if let Ok(e) = host.get() {
        e.session_close(&id).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn session_send(
    host: State<'_, DriverHost>,
    id: String,
    ftype: String,
    payload: Value,
) -> Result<(), String> {
    host.get()?.session_send(&id, &ftype, payload).await
}

#[tauri::command]
pub async fn session_call(
    host: State<'_, DriverHost>,
    id: String,
    kind: String,
    payload: Value,
) -> Result<Value, String> {
    host.get()?.session_call(&id, &kind, payload).await
}

/// repo 只读查询(文件树/读文件/变更/diff/定位)。原生实现,双引擎共用;
/// 应答 {result}/{error} 与内核 call-response 载荷同构。
#[tauri::command]
pub async fn repo_call(
    host: State<'_, DriverHost>,
    id: String,
    kind: String,
    payload: Value,
) -> Result<Value, String> {
    let engine = host.get()?;
    let workdir = engine.session_workdir(&id).await?;
    let ctx = RepoCtx { workdir, wsl_distro: engine.wsl_distro() };
    // git/fs 是阻塞操作,丢 blocking 池;15s 超时对齐旧 WS call 语义——
    // WSL 睡眠恢复后 wsl.exe 可能挂死,不设限文件面板会永久转圈
    let task = tauri::async_runtime::spawn_blocking(move || crate::repo::dispatch(&ctx, &kind, &payload));
    match tokio::time::timeout(std::time::Duration::from_secs(15), task).await {
        Ok(r) => r.map_err(|e| format!("repo 查询失败: {e}")),
        Err(_) => Err("repo 查询超时(15s)".into()),
    }
}

#[tauri::command]
pub async fn upload_file(
    host: State<'_, DriverHost>,
    id: String,
    name: String,
    media_type: String,
    data: String,
) -> Result<Value, String> {
    let engine = host.get()?;
    let workdir = engine.session_workdir(&id).await?;
    let distro = engine.wsl_distro();
    tauri::async_runtime::spawn_blocking(move || {
        crate::uploads::save(&workdir, distro.as_deref(), &name, &media_type, &data)
    })
    .await
    .map_err(|e| format!("上传失败: {e}"))?
}

#[tauri::command]
pub async fn upload_read(host: State<'_, DriverHost>, id: String, path: String) -> Result<String, String> {
    let engine = host.get()?;
    let workdir = engine.session_workdir(&id).await?;
    let distro = engine.wsl_distro();
    tauri::async_runtime::spawn_blocking(move || {
        crate::uploads::read_data_url(&workdir, distro.as_deref(), &path)
    })
    .await
    .map_err(|e| format!("读取失败: {e}"))?
}

/// 内核 HTTP 代理:仅浏览器扩展桥(/api/browser/*)保留——扩展桥与 agent 的
/// browser_* 工具深耦合,永驻 mc-agent 进程;其余业务 API 已原生化(baizhi/)。
#[tauri::command]
pub async fn kernel_http(
    host: State<'_, DriverHost>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if !path.starts_with("/api/browser/") {
        return Err("kernel_http 仅允许 /api/browser/ 路径".into());
    }
    host.get()?.kernel_http(&method, &path, body).await
}
