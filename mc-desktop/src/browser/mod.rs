// 浏览器扩展桥(自 mc-agent 迁入壳):自研 MV3 扩展经本地 WS 桥接,
// agent 在用户真实浏览器(Chrome/Edge)中执行 CDP 操作。
//
// 分层:
//   protocol.rs  扩展↔壳 WS 契约(Op/Ev/错误码/中文文案,PROTO_VERSION=1,
//                与 browser-extension/src/protocol.ts 对表——扩展零改动)
//   bridge.rs    WS server(/ext,7440 起顺延 10 端口)+ 配对鉴权 + 连接管理
//   cdp.rs       CDP-over-bridge 薄客户端
//   session.rs   浏览器会话现场(tab/refs/notes/对话框/OOPIF)
//   ops.rs       9 个 browser_* 工具语义 + MCP 工具元数据
//   keys.rs/refs.rs/snapshot.rs  键表/元素引用表/页面采集 JS
//   mcp.rs       MCP streamable-http server:把工具暴露给 ohmyagent
//                (Bearer 鉴权,URL+token 经 mcp.json 内置条目物化下发)
//
// 会话归属简化(与 mc-agent 的差异):MCP 工具调用不带会话身份,桥为
// 单一共享浏览器会话(桌面单用户);handoff 队列归全局。

pub mod bridge;
pub mod cdp;
pub mod keys;
pub mod mcp;
pub mod ops;
pub mod protocol;
pub mod refs;
pub mod session;
pub mod snapshot;

#[cfg(test)]
mod tests;

use std::sync::OnceLock;

use tauri::{AppHandle, Manager, State};

/// 全局桥实例(进程级单例;setup 时初始化)。
pub struct BrowserHost {
    pub bridge: bridge::ExtBridge,
    #[allow(dead_code)] // 后续壳命令扩展(如主动 close)保留句柄
    pub session: session::BrowserSession,
}

/// MCP server 的接入信息(config.rs 物化 mcp.json 内置条目时读)。
static MCP_ENDPOINT: OnceLock<(String, String)> = OnceLock::new(); // (url, bearer_token)

pub fn mcp_endpoint() -> Option<(String, String)> {
    MCP_ENDPOINT.get().cloned()
}

/// 初始化浏览器桥 + MCP server(setup 阶段调用,先于引擎启动——
/// 引擎配置物化需要 MCP URL/token)。失败不阻断应用(能力降级)。
pub fn init(app: &AppHandle) {
    let data_dir = match crate::config::config_dir(app) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[mc-desktop] 浏览器桥初始化失败(配置目录): {e}");
            return;
        }
    };
    let b = bridge::ExtBridge::new(7440, &data_dir);
    b.spawn();
    let sess = session::BrowserSession::new(b.clone());
    match mcp::serve(sess.clone()) {
        Ok((url, token)) => {
            let _ = MCP_ENDPOINT.set((url, token));
        }
        Err(e) => eprintln!("[mc-desktop] 浏览器 MCP server 启动失败: {e}"),
    }
    app.manage(BrowserHost { bridge: b, session: sess });
}

// ==================== Tauri 命令(设置页) ====================

#[tauri::command]
pub fn browser_status(host: State<'_, BrowserHost>) -> serde_json::Value {
    host.bridge.status()
}

#[tauri::command]
pub fn browser_repair(host: State<'_, BrowserHost>) -> serde_json::Value {
    host.bridge.repair()
}
