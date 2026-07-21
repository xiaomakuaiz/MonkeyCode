// MCP streamable-http server:把浏览器工具暴露给 ohmyagent(它是 MCP 客户端,
// go-sdk StreamableClientTransport)。手写最小面而非引 HTTP 框架:
// 客户端契约(实测 go-sdk v1.6.1)只需要——
//   POST application/json → 应答 application/json 的 JSON-RPC(无需 SSE);
//   通知(无 id,如 notifications/initialized)→ 202 无体;
//   GET(standalone SSE)→ 405 即被容忍(spec §2.2.3);
//   会话头 Mcp-Session-Id 可不发(server MAY assign)。
// 鉴权:随机 Bearer token,经 mcp.json 内置条目的 headers 下发给引擎——
// MCP 面能驱动用户浏览器,不能对本机任意进程裸奔。
//
// 工具串行:所有 browser_* 共享一个浏览器会话与 debugger 连接,并行会竞争,
// 用互斥锁保证。

use std::io::{Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

use base64::Engine as _;
use serde_json::{json, Value};

use super::ops::tool_metas;
use super::session::BrowserSession;

/// 当前运行会话的工作区(截图落盘定位;None = 无运行中会话,跳过落盘)。
pub type WorkdirFn = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// 启动 MCP server(随机端口),返回 (url, bearer_token)。
/// 阻塞式 HTTP 处理跑在独立线程(请求频率 = 工具调用频率,极低)。
pub fn serve(sess: BrowserSession, workdir: WorkdirFn) -> Result<(String, String), String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("MCP 监听失败: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let token = new_token();
    let url = format!("http://{addr}/mcp");

    let tok = token.clone();
    // 工具串行锁(见文件头);持锁跨 await 由 tokio Mutex 承担
    let call_mu = Arc::new(tokio::sync::Mutex::new(()));
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(conn) = conn else { continue };
            let sess = sess.clone();
            let tok = tok.clone();
            let mu = call_mu.clone();
            let wd = workdir.clone();
            std::thread::spawn(move || handle_conn(conn, &sess, &tok, &mu, &wd));
        }
    });
    Ok((url, token))
}

fn new_token() -> String {
    // 随机 32 hex:进程内每次启动新发(mcp.json 随引擎重启重写,不需持久)
    let mut buf = [0u8; 16];
    getrandom(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 平台无关的随机字节(std 无直接接口;用 UUID 思路:时间 + 地址熵会太弱,
/// 这里读 /dev/urandom,Windows 用 std 的 RandomState 哈希链兜底)。
fn getrandom(buf: &mut [u8]) {
    #[cfg(unix)]
    {
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            if f.read_exact(buf).is_ok() {
                return;
            }
        }
    }
    // 兜底:RandomState 内部持系统熵种子,哈希链导出
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let rs = RandomState::new();
    let mut x: u64 = 0;
    for chunk in buf.chunks_mut(8) {
        let mut h = rs.build_hasher();
        h.write_u64(x);
        x = h.finish();
        for (i, b) in chunk.iter_mut().enumerate() {
            *b = (x >> (8 * i)) as u8;
        }
    }
}

fn handle_conn(mut conn: TcpStream, sess: &BrowserSession, token: &str, mu: &tokio::sync::Mutex<()>, workdir: &WorkdirFn) {
    let Some(req) = read_http_request(&mut conn) else { return };

    if req.bearer.as_deref() != Some(token) {
        write_http(&mut conn, 401, "application/json", br#"{"error":"unauthorized"}"#);
        return;
    }
    if req.method != "POST" {
        // GET(standalone SSE)按 spec 返回 405,go-sdk 客户端容忍
        write_http(&mut conn, 405, "text/plain", b"method not allowed");
        return;
    }
    let Ok(rpc) = serde_json::from_slice::<Value>(&req.body) else {
        write_http(&mut conn, 400, "text/plain", b"bad json");
        return;
    };

    // 通知(无 id):202 无体
    if rpc.get("id").is_none() {
        write_http(&mut conn, 202, "application/json", b"");
        return;
    }
    let id = rpc.get("id").cloned().unwrap_or(Value::Null);
    let method = rpc.get("method").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let params = rpc.get("params").cloned().unwrap_or(Value::Null);

    // 工具执行是 async(桥 call 走 tokio);当前线程无 runtime,借 tauri 全局
    let result = tauri::async_runtime::block_on(dispatch(sess, mu, workdir, &method, params));
    let resp = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, msg)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } })
        }
    };
    write_http(&mut conn, 200, "application/json", resp.to_string().as_bytes());
}

async fn dispatch(
    sess: &BrowserSession,
    mu: &tokio::sync::Mutex<()>,
    workdir: &WorkdirFn,
    method: &str,
    params: Value,
) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            // 协议版本:回显客户端请求的版本(go-sdk 校验应答版本可识别)
            let ver = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("2025-03-26");
            Ok(json!({
                "protocolVersion": ver,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "mc-browser", "version": env!("CARGO_PKG_VERSION") },
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => {
            let tools: Vec<Value> = tool_metas()
                .iter()
                .map(|t| {
                    json!({ "name": t.name, "description": t.description, "inputSchema": (t.input_schema)() })
                })
                .collect();
            Ok(json!({ "tools": tools }))
        }
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let _g = mu.lock().await;
            // 单次工具调用总超时:导航等待/整页截图都在其内
            let out = tokio::time::timeout(
                std::time::Duration::from_secs(180),
                call_tool(sess, workdir, &name, &args),
            )
            .await
            .unwrap_or_else(|_| Err("浏览器操作超时(180s)".into()));
            // MCP 语义:工具失败走 isError 带回模型(可行动文案),不是协议错误
            Ok(match out {
                Ok(content) => json!({ "content": content, "isError": false }),
                Err(msg) => json!({ "content": [{ "type": "text", "text": msg }], "isError": true }),
            })
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    }
}

/// 工具分派:名称/入参形态对齐 ops.rs 的 tool_metas(即 Go tools.go)。
async fn call_tool(
    sess: &BrowserSession,
    workdir: &WorkdirFn,
    name: &str,
    args: &Value,
) -> Result<Vec<Value>, String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let text_block = |t: String| vec![json!({ "type": "text", "text": t })];
    match name {
        "browser_navigate" => sess.navigate(&s("url")).await.map(text_block),
        "browser_snapshot" => sess.snapshot().await.map(text_block),
        "browser_take_screenshot" => {
            let full = args.get("full_page").and_then(|v| v.as_bool()).unwrap_or(false);
            let (png, mut note) = sess.screenshot(full).await?;
            // 截图同时落当前会话工作区:UI 工具卡按路径内联显示
            // (帧协议传路径不传 base64);模型侧走 MCP image 块直达
            // (上游 c1d8482 起)
            if let Some(wd) = workdir() {
                let name = format!("browser-{}.png", crate::driver::frame::now_ms());
                match crate::uploads::save_raw(&wd, None, &name, &png) {
                    Ok(rel) => note.push_str(&format!("\n截图已保存: {rel}")),
                    Err(e) => eprintln!("[desktop] 截图落盘失败: {e}"),
                }
            }
            Ok(vec![
                json!({ "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(&png), "mimeType": "image/png" }),
                json!({ "type": "text", "text": note }),
            ])
        }
        "browser_click" => sess.click(&s("ref")).await.map(text_block),
        "browser_type" => {
            let clear = args.get("clear").and_then(|v| v.as_bool()).unwrap_or(true);
            let submit = args.get("submit").and_then(|v| v.as_bool()).unwrap_or(false);
            sess.type_text(&s("ref"), &s("text"), clear, submit).await.map(text_block)
        }
        "browser_select_option" => {
            let values: Vec<String> = args
                .get("values")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            sess.select_option(&s("ref"), &values).await.map(text_block)
        }
        "browser_press_key" => sess.press_key(&s("key")).await.map(text_block),
        "browser_scroll" => {
            let dir = args.get("direction").and_then(|v| v.as_str());
            let r = args.get("ref").and_then(|v| v.as_str());
            sess.scroll(dir, r).await.map(text_block)
        }
        "browser_tabs" => {
            let tab_id = args.get("tab_id").and_then(|v| v.as_i64());
            let url = args.get("url").and_then(|v| v.as_str());
            sess.tabs(&s("action"), tab_id, url).await.map(text_block)
        }
        other => Err(format!("未知工具: {other}")),
    }
}

// ==================== 最小 HTTP(单请求,Connection: close) ====================

struct HttpReq {
    method: String,
    bearer: Option<String>,
    body: Vec<u8>,
}

fn read_http_request(conn: &mut TcpStream) -> Option<HttpReq> {
    let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    let mut reader = std::io::BufReader::new(conn.try_clone().ok()?);
    use std::io::BufRead as _;
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let method = line.split_whitespace().next()?.to_string();
    let mut bearer = None;
    let mut content_len = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
            break;
        }
        let lower = h.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            content_len = v.trim().parse().unwrap_or(0);
        }
        if lower.starts_with("authorization:") {
            // 原始行取值(token 大小写敏感)
            let v = h.splitn(2, ':').nth(1).unwrap_or("").trim();
            bearer = v.strip_prefix("Bearer ").map(str::to_string);
        }
    }
    // 体量上限 4MB:工具入参不会更大,防异常端灌爆内存
    if content_len > 4 * 1024 * 1024 {
        return None;
    }
    let mut body = vec![0u8; content_len];
    reader.read_exact(&mut body).ok()?;
    Some(HttpReq { method, bearer, body })
}

fn write_http(conn: &mut TcpStream, status: u16, ctype: &str, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = conn.write_all(head.as_bytes());
    let _ = conn.write_all(body);
}
