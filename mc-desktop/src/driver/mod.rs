// 引擎驱动层:UI 只经 Tauri IPC 与壳对话,壳适配 ohmyagent 内核(stdio)。
//
// 下行帧统一走 Tauri 事件(UI 按会话订阅 `frames:{sid}`,帧为 Frame
// 词汇——引擎事件在 driver 内归一化,reduce 层零改动):
//   frames:{sid}       Frame[](~30ms 批量,防高频 delta 拖垮 IPC)
//   conn-status:{sid}  {text, connected} 会话流连接状态
//   session-event      {type: session-status|session-ask, ...} 全局状态(侧栏+桌宠)
//   ws-msg:{pipe}      云端 WS 桥下行文本帧(协议逻辑仍在 UI,壳只做管道)
//   ws-closed:{pipe}   云端 WS 桥断开
//
// 上行统一走 invoke 命令(本文件底部,main.rs 注册)。

pub mod frame;
pub mod ohmy;

use std::sync::Mutex;

use ohmy::OhmyDriver;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::config::DesktopConfig;
use crate::repo::RepoCtx;

/// 当前引擎(壳生命周期内至多一个;保存设置时整体替换)。
/// 内层是廉价克隆的句柄:命令先克隆再 await,不跨 await 持锁。
pub struct DriverHost(pub Mutex<Option<OhmyDriver>>);

impl DriverHost {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn get(&self) -> Result<OhmyDriver, String> {
        self.0.lock().unwrap().clone().ok_or_else(|| "引擎未运行".to_string())
    }

    pub fn running(&self) -> bool {
        self.0.lock().unwrap().is_some()
    }

    pub fn set(&self, e: OhmyDriver) {
        *self.0.lock().unwrap() = Some(e);
    }

    pub fn take(&self) -> Option<OhmyDriver> {
        self.0.lock().unwrap().take()
    }
}

/// 引擎能力表(对表 mc-desktop/ui/src/client.ts 的 EngineCaps)。
/// 能力仍是渐进的(随上游补齐翻位),单一事实来源:UI 降级与命令层
/// 守卫都从这里读,driver 内不得各自硬编码能力判断。
#[derive(Clone, Copy, serde::Serialize)]
pub struct Caps {
    /// 浏览器扩展桥(壳内 browser/ 模块,MCP 暴露给引擎)
    pub browser_ext: bool,
    /// 待上游按次调用出 usage(turn/stopped 仅整轮累计,撑不起上下文条)
    pub usage_update: bool,
    pub perm_remember: bool,
    pub attachments: bool,
}

pub fn caps() -> Caps {
    Caps { browser_ext: true, usage_update: false, perm_remember: true, attachments: true }
}

/// 日志尾部(崩溃外显用;文件缺失返回空)。
pub fn log_tail(path: &std::path::Path, lines: usize) -> String {
    std::fs::read(path)
        .map(|b| {
            let s = crate::wsl::decode_wsl_output(&b);
            let all: Vec<_> = s.lines().collect();
            all[all.len().saturating_sub(lines)..].join("\n")
        })
        .unwrap_or_default()
}

/// 按配置启动引擎(阻塞等就绪;setup 与 save_config 共用)。
pub fn start_engine(app: &AppHandle, cfg: &DesktopConfig) -> Result<OhmyDriver, String> {
    OhmyDriver::start(app.clone(), cfg)
}

// ==================== Tauri 命令 ====================

#[tauri::command]
pub async fn engine_caps(host: State<'_, DriverHost>) -> Result<Caps, String> {
    host.get()?;
    Ok(caps())
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

/// 会话 call 统一入口:repo_* 前缀在命令层分派到壳原生实现(UI 不感知
/// 谁执行),其余交引擎。应答 {result}/{error} 载荷同构。
#[tauri::command]
pub async fn session_call(
    host: State<'_, DriverHost>,
    id: String,
    kind: String,
    payload: Value,
) -> Result<Value, String> {
    let engine = host.get()?;
    if kind.starts_with("repo_") {
        let workdir = engine.session_workdir(&id).await?;
        // wsl_distro 待 M3(ohmy WSL 模式)接回
        let ctx = RepoCtx { workdir, wsl_distro: None };
        // git/fs 是阻塞操作,丢 blocking 池;15s 超时防文件面板永久转圈
        let task = tauri::async_runtime::spawn_blocking(move || crate::repo::dispatch(&ctx, &kind, &payload));
        return match tokio::time::timeout(std::time::Duration::from_secs(15), task).await {
            Ok(r) => r.map_err(|e| format!("repo 查询失败: {e}")),
            Err(_) => Err("repo 查询超时(15s)".into()),
        };
    }
    engine.session_call(&id, &kind, payload).await
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
    tauri::async_runtime::spawn_blocking(move || crate::uploads::save(&workdir, None, &name, &media_type, &data))
        .await
        .map_err(|e| format!("上传失败: {e}"))?
}

#[tauri::command]
pub async fn upload_read(host: State<'_, DriverHost>, id: String, path: String) -> Result<String, String> {
    let engine = host.get()?;
    let workdir = engine.session_workdir(&id).await?;
    tauri::async_runtime::spawn_blocking(move || crate::uploads::read_data_url(&workdir, None, &path))
        .await
        .map_err(|e| format!("读取失败: {e}"))?
}
