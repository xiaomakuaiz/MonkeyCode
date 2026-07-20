// 浏览器桥集成测试:假扩展(WS 客户端)走真实配对/调用链;MCP 面 HTTP 冒烟。
// 契约对齐 agent/internal/browser/bridge_test.go 的关键断言。

use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::{json, Value};

use super::bridge::ExtBridge;
use super::mcp;
use super::session::BrowserSession;

fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("mc-browser-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// 轮询桥就绪并取实际地址。
async fn wait_addr(b: &ExtBridge) -> String {
    for _ in 0..50 {
        let st = b.status();
        if let Some(addr) = st.get("addr").and_then(|v| v.as_str()) {
            if !addr.is_empty() {
                return addr.to_string();
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("桥未就绪: {:?}", b.status());
}

#[tokio::test(flavor = "multi_thread")]
async fn bridge_pair_and_call_roundtrip() {
    let dir = tmp_dir("bridge");
    let b = ExtBridge::new(27440, &dir);
    b.spawn();
    let addr = wait_addr(&b).await;

    // 配对:用状态页展示的一次性配对码(小写 + 连字符,测 normalize)
    let code = b.status().get("pairing_code").and_then(|v| v.as_str()).unwrap().to_string();
    let scrambled = format!("{}-{}", code[..4].to_lowercase(), &code[4..]);
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ext")).await.expect("连接");
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        json!({ "event": "hello", "proto": 1,
            "auth": { "code": scrambled },
            "ext": { "id": "ext-test", "version": "1" },
            "browser": { "name": "TestChrome", "version": "1.0" } })
        .to_string(),
    ))
    .await
    .unwrap();
    let reply: Value = match ws.next().await.unwrap().unwrap() {
        tokio_tungstenite::tungstenite::Message::Text(t) => serde_json::from_str(&t).unwrap(),
        other => panic!("非文本帧: {other:?}"),
    };
    assert_eq!(reply.get("event").and_then(|v| v.as_str()), Some("hello.ok"));
    let token = reply.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    assert_eq!(token.len(), 32, "配对应颁发 32 hex token");

    // 已配对状态外显 + 浏览器信息
    let st = b.status();
    assert_eq!(st.get("paired").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(st.get("connected").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(st.get("browser_name").and_then(|v| v.as_str()), Some("TestChrome"));

    // 调用往返:假扩展应答 tabs.list
    let b2 = b.clone();
    let call = tauri::async_runtime::spawn(async move {
        let mut req = super::protocol::Request::default();
        req.op = super::protocol::OP_TABS_LIST.to_string();
        b2.call(req, Duration::from_secs(5)).await
    });
    // 假扩展侧:收到请求,按 id 回 result
    let req: Value = match ws.next().await.unwrap().unwrap() {
        tokio_tungstenite::tungstenite::Message::Text(t) => serde_json::from_str(&t).unwrap(),
        other => panic!("非文本帧: {other:?}"),
    };
    assert_eq!(req.get("op").and_then(|v| v.as_str()), Some("tabs.list"));
    let id = req.get("id").and_then(|v| v.as_i64()).unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        json!({ "id": id, "result": [{ "tabId": 7, "url": "https://a", "title": "A" }] }).to_string(),
    ))
    .await
    .unwrap();
    let result = call.await.unwrap().expect("call 应成功");
    assert_eq!(result[0]["tabId"].as_i64(), Some(7));

    // 扩展错误码 → 中文可行动文案
    let b3 = b.clone();
    let call2 = tauri::async_runtime::spawn(async move {
        let mut req = super::protocol::Request::default();
        req.op = super::protocol::OP_ATTACH.to_string();
        req.tab_id = Some(7);
        b3.call(req, Duration::from_secs(5)).await
    });
    let req2: Value = match ws.next().await.unwrap().unwrap() {
        tokio_tungstenite::tungstenite::Message::Text(t) => serde_json::from_str(&t).unwrap(),
        other => panic!("非文本帧: {other:?}"),
    };
    let id2 = req2.get("id").and_then(|v| v.as_i64()).unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        json!({ "id": id2, "error": { "code": "not_controlled" } }).to_string(),
    ))
    .await
    .unwrap();
    let err = call2.await.unwrap().expect_err("应报错");
    assert!(err.contains("交给 agent 操作"), "错误文案未翻译: {err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_smoke_initialize_list_call() {
    let dir = tmp_dir("mcp");
    let b = ExtBridge::new(27460, &dir);
    // 不 spawn 桥监听:MCP 面不依赖扩展在线
    let sess = BrowserSession::new(b);
    let (url, token) = mcp::serve(sess).expect("MCP 启动");

    let post = |body: Value, auth: Option<String>| {
        let url = url.clone();
        async move {
            let mut req = format!(
                "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n"
            );
            if let Some(t) = auth {
                req.push_str(&format!("Authorization: Bearer {t}\r\n"));
            }
            let body = body.to_string();
            req.push_str(&format!("Content-Length: {}\r\n\r\n{}", body.len(), body));
            let addr = url.strip_prefix("http://").unwrap().split('/').next().unwrap().to_string();
            let mut conn = tokio::net::TcpStream::connect(&addr).await.unwrap();
            use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
            conn.write_all(req.as_bytes()).await.unwrap();
            let mut buf = Vec::new();
            let _ = conn.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).into_owned()
        }
    };

    // 未带 token → 401
    let resp = post(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }), None).await;
    assert!(resp.starts_with("HTTP/1.1 401"), "缺鉴权应 401: {resp}");

    // initialize:回显协议版本
    let resp = post(
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" } }),
        Some(token.clone()),
    )
    .await;
    assert!(resp.contains(r#""protocolVersion":"2025-06-18""#), "initialize 应答不对: {resp}");
    assert!(resp.contains("mc-browser"));

    // tools/list:9 个工具,名字与 mc-agent 契约一致
    let resp = post(
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        Some(token.clone()),
    )
    .await;
    for name in [
        "browser_navigate", "browser_snapshot", "browser_take_screenshot", "browser_click",
        "browser_type", "browser_select_option", "browser_press_key", "browser_scroll", "browser_tabs",
    ] {
        assert!(resp.contains(name), "tools/list 缺 {name}");
    }

    // tools/call(无标签页)→ isError:true + 可行动引导文案(不是协议错误;
    // 无 tab 的引导在会话层短路,尚未触达"扩展未连接"——与 Go 语义一致)
    let resp = post(
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "browser_snapshot", "arguments": {} } }),
        Some(token.clone()),
    )
    .await;
    assert!(resp.contains(r#""isError":true"#), "应 isError: {resp}");
    assert!(resp.contains("当前没有活动标签页"), "缺可行动文案: {resp}");

    // 通知 → 202
    let resp = post(
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        Some(token),
    )
    .await;
    assert!(resp.starts_with("HTTP/1.1 202"), "通知应 202: {resp}");
}
