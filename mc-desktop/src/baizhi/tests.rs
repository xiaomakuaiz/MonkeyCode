// baizhi 集成测试:假服务端跑通协议全链路(对照 Go 侧 client_test.go /
// monkeycode_test.go 的场景)。PoW 解由服务端按协议独立校验,与求解器实现解耦。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{Endpoints, Service};

/// 假服务端收到的一次请求。
struct Req {
    method: String,
    path: String, // 含查询串
    cookie: String,
    body: Vec<u8>,
}

/// 应答:状态码 + 额外头 + JSON 体。
struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Resp {
    fn json(status: u16, v: Value) -> Self {
        Resp { status, headers: vec![("Content-Type".into(), "application/json".into())], body: v.to_string().into_bytes() }
    }
    fn with_cookie(mut self, c: &str) -> Self {
        self.headers.push(("Set-Cookie".into(), c.into()));
        self
    }
    fn redirect(loc: &str) -> Self {
        Resp { status: 302, headers: vec![("Location".into(), loc.into())], body: vec![] }
    }
}

type Handler = Arc<dyn Fn(Req) -> Resp + Send + Sync>;

/// 极简 HTTP 服务(单线程 accept;Connection: close 简化解析)。
fn serve(handler: Handler) -> (String, Arc<AtomicBool>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if stop2.load(Ordering::Relaxed) {
                break;
            }
            let Ok(mut conn) = conn else { continue };
            let handler = handler.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(conn.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line.is_empty() {
                    return;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("").to_string();
                let mut cookie = String::new();
                let mut content_len = 0usize;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                        break;
                    }
                    let lower = h.to_ascii_lowercase();
                    if lower.starts_with("cookie:") {
                        cookie = h[7..].trim().to_string();
                    }
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        content_len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; content_len];
                if content_len > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let resp = handler(Req { method, path, cookie, body });
                let mut out = format!("HTTP/1.1 {} X\r\nConnection: close\r\nContent-Length: {}\r\n", resp.status, resp.body.len());
                for (k, v) in &resp.headers {
                    out.push_str(&format!("{k}: {v}\r\n"));
                }
                out.push_str("\r\n");
                let _ = conn.write_all(out.as_bytes());
                let _ = conn.write_all(&resp.body);
            });
        }
    });
    (format!("http://{addr}"), stop)
}

fn body_json(b: &[u8]) -> Value {
    serde_json::from_slice(b).unwrap_or(Value::Null)
}

/// prng 复刻(服务端独立校验 PoW 解;与 pow.rs 实现同协议)。
fn prng(seed: &str, length: usize) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for b in seed.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    let mut state = hash;
    let mut out = String::new();
    while out.len() < length {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        out.push_str(&format!("{state:08x}"));
    }
    out.truncate(length);
    out
}

/// 手机号登录全链路:challenge(201) → redeem(独立校验解) → 发码 → 登录种
/// cookie → profile 校验 cookie(对照 Go TestLoginFlow)。
#[tokio::test(flavor = "multi_thread")]
async fn login_flow() {
    let state = Arc::new(Mutex::new((String::new(), String::new(), String::new()))); // (challenge_token, captcha_token, session)
    let st = state.clone();
    let (url, _stop) = serve(Arc::new(move |req: Req| {
        let mut s = st.lock().unwrap();
        match (req.method.as_str(), req.path.split('?').next().unwrap()) {
            ("POST", "/api/v1/public/captcha/challenge") => {
                s.0 = "chtok-123".into();
                // 真实服务端回 201,钉住 2xx 兼容
                Resp::json(201, json!({ "challenge": {"c": 3, "s": 32, "d": 3}, "token": s.0 }))
            }
            ("POST", "/api/v1/public/captcha/redeem") => {
                let b = body_json(&req.body);
                let token = b.get("token").and_then(|v| v.as_str()).unwrap_or("");
                let sols: Vec<u64> = b
                    .get("solutions")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
                    .unwrap_or_default();
                if token != s.0 || sols.len() != 3 {
                    return Resp::json(200, json!({ "success": false, "message": "质询不匹配" }));
                }
                // 独立校验每个解(协议本身的校验逻辑,与求解器实现无关)
                for (i, nonce) in sols.iter().enumerate() {
                    let idx = (i + 1).to_string();
                    let salt = prng(&format!("{token}{idx}"), 32);
                    let target = prng(&format!("{token}{idx}d"), 3);
                    let mut h = Sha256::new();
                    h.update(salt.as_bytes());
                    h.update(nonce.to_string().as_bytes());
                    let hex = h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
                    if !hex.starts_with(&target) {
                        return Resp::json(200, json!({ "success": false, "message": "PoW 解无效" }));
                    }
                }
                s.1 = "captok-456".into();
                Resp::json(200, json!({ "success": true, "token": s.1 }))
            }
            ("POST", "/api/v1/user/phone_code") => {
                let b = body_json(&req.body);
                if b.get("captcha_token").and_then(|v| v.as_str()) != Some(s.1.as_str()) {
                    return Resp::json(400, json!({ "code": 400, "message": "验证码无效 [trace_id:abc123]" }));
                }
                assert_eq!(b.get("kind").and_then(|v| v.as_str()), Some("login"));
                Resp::json(200, json!({ "code": 0 }))
            }
            ("POST", "/api/v1/user/login/phone") => {
                let b = body_json(&req.body);
                if b.get("phone").and_then(|v| v.as_str()) != Some("13800138000")
                    || b.get("code").and_then(|v| v.as_str()) != Some("123456")
                {
                    return Resp::json(400, json!({ "code": 401, "message": "验证码错误" }));
                }
                s.2 = "sess-789".into();
                Resp::json(200, json!({ "code": 0 })).with_cookie("baizhi_session=sess-789; Path=/; HttpOnly")
            }
            ("GET", "/api/v1/user/profile") => {
                if s.2.is_empty() || !req.cookie.contains(&format!("baizhi_session={}", s.2)) {
                    return Resp { status: 401, headers: vec![], body: b"Unauthorized".to_vec() };
                }
                Resp::json(200, json!({ "code": 0, "data": {"phone": "13800138000", "name": "测试用户"} }))
            }
            _ => Resp::json(404, json!({ "message": "not found" })),
        }
    }));

    let svc = Service::test_service(Endpoints {
        account: url.clone(),
        model_gateway: url.clone(),
        mcp_gateway: url.clone(),
        monkeycode: url.clone(),
    });

    // 未登录状态
    let (li, _) = svc.status().await.map_err(|e| e.msg()).unwrap();
    assert!(!li);

    // 发码 + 登录
    svc.send_phone_code("13800138000").await.map_err(|e| e.msg()).unwrap();
    svc.login_phone("13800138000", "123456").await.map_err(|e| e.msg()).unwrap();

    // 会话已持久化,profile 探测为已登录
    let (li, profile) = svc.status().await.map_err(|e| e.msg()).unwrap();
    assert!(li);
    assert_eq!(profile.get("name").and_then(|v| v.as_str()), Some("测试用户"));

    // 登出清罐
    svc.store.clear();
    let (li, _) = svc.status().await.map_err(|e| e.msg()).unwrap();
    assert!(!li);
}

/// trace_id 清洗:验证失败 message 尾部标注被剥掉(对照 Go TestSendCodeError)。
#[tokio::test(flavor = "multi_thread")]
async fn error_message_cleaned() {
    let (url, _stop) = serve(Arc::new(|req: Req| {
        match req.path.split('?').next().unwrap() {
            "/api/v1/public/captcha/challenge" => {
                Resp::json(201, json!({ "challenge": {"c": 1, "s": 8, "d": 1}, "token": "t" }))
            }
            "/api/v1/public/captcha/redeem" => Resp::json(200, json!({ "success": true, "token": "cap" })),
            _ => Resp::json(400, json!({ "code": 400, "message": "验证码无效 [trace_id:abc123]" })),
        }
    }));
    let svc = Service::test_service(Endpoints {
        account: url.clone(),
        model_gateway: url.clone(),
        mcp_gateway: url.clone(),
        monkeycode: url,
    });
    let err = svc.send_phone_code("13800138000").await.err().map(|e| e.msg()).unwrap();
    assert_eq!(err, "验证码无效");
}

/// MonkeyCode 桥接登录:手动跟随重定向链(mc → 授权页改写 API → 回调种
/// mc cookie → 前端页 2xx),cookie 分罐(对照 Go TestLoginMonkeyCode)。
#[tokio::test(flavor = "multi_thread")]
async fn monkeycode_bridge_login() {
    // 两个"域":account 与 mc(同 IP 不同端口,storeFor 按 host:port 分罐)
    let mc_session = Arc::new(Mutex::new(String::new()));

    // account 假服务:授权 API 校验百智 cookie 后 302 回 mc callback
    let ms = mc_session.clone();
    let mc_url_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let mh = mc_url_holder.clone();
    let (account_url, _s1) = serve(Arc::new(move |req: Req| {
        match req.path.split('?').next().unwrap() {
            "/api/v1/oauth/authorize" => {
                // 必须带百智会话 cookie
                if !req.cookie.contains("baizhi_session=sess-1") {
                    return Resp { status: 401, headers: vec![], body: b"{}".to_vec() };
                }
                // 校验参数齐全(response_type=code)
                assert!(req.path.contains("client_id=cid"));
                assert!(req.path.contains("response_type=code"));
                let mc = mh.lock().unwrap().clone();
                Resp::redirect(&format!("{mc}/api/v1/users/login/callback?code=authcode-1"))
            }
            "/api/v1/user/profile" => Resp::json(200, json!({ "code": 0, "data": {"name": "u"} })),
            _ => Resp::json(404, json!({})),
        }
    }));

    // mc 假服务:login 302 到授权"页面";callback 种 mc 会话再 302 前端;status 校验 cookie
    let ms2 = mc_session.clone();
    let account2 = account_url.clone();
    let (mc_url, _s2) = serve(Arc::new(move |req: Req| {
        match req.path.split('?').next().unwrap() {
            "/api/v1/users/login" => Resp::redirect(&format!(
                "{account2}/oauth/authorize?client_id=cid&redirect_uri={account2}/cb&scope=all&state=st1"
            )),
            "/api/v1/users/login/callback" => {
                assert!(req.path.contains("code=authcode-1"));
                *ms2.lock().unwrap() = "mcsess-1".into();
                Resp::redirect("/dashboard").with_cookie("mc_session=mcsess-1; Path=/; HttpOnly")
            }
            "/dashboard" => Resp::json(200, json!({ "ok": true })),
            "/api/v1/users/status" => {
                let sess = ms2.lock().unwrap().clone();
                if sess.is_empty() || !req.cookie.contains(&format!("mc_session={sess}")) {
                    return Resp::json(200, json!({ "code": 0, "data": {"user": {}} }));
                }
                Resp::json(200, json!({ "code": 0, "data": {"user": {"id": "u1", "name": "云端用户"}} }))
            }
            _ => Resp::json(404, json!({})),
        }
    }));
    *mc_url_holder.lock().unwrap() = mc_url.clone();
    let _ = ms;

    let svc = Service::test_service(Endpoints {
        account: account_url.clone(),
        model_gateway: account_url.clone(),
        mcp_gateway: account_url.clone(),
        monkeycode: mc_url,
    });

    // 未持有百智会话 → 拒绝
    assert!(super::monkeycode::login_monkeycode(&svc).await.is_err());

    // 种百智会话后走通桥接
    svc.store.update(
        &reqwest::Url::parse(&format!("{account_url}/")).unwrap(),
        &["baizhi_session=sess-1; Path=/".to_string()],
    );
    let user = super::monkeycode::login_monkeycode(&svc).await.map_err(|e| e.msg()).unwrap();
    assert_eq!(user.get("id").and_then(|v| v.as_str()), Some("u1"));

    // mc 会话已入独立罐:status 走 mc 罐;百智登出不影响云端会话
    let (li, user) = super::monkeycode::mc_status(&svc).await.map_err(|e| e.msg()).unwrap();
    assert!(li);
    assert_eq!(user.get("name").and_then(|v| v.as_str()), Some("云端用户"));
    svc.store.clear();
    let (li, _) = super::monkeycode::mc_status(&svc).await.map_err(|e| e.msg()).unwrap();
    assert!(li, "百智登出不应牵连 MonkeyCode 会话");
}

/// rounds 归一化:event→type、纳秒→毫秒、seq/kind/data 透传(对照 Go TestTaskRounds)。
#[tokio::test(flavor = "multi_thread")]
async fn rounds_normalization() {
    let (url, _stop) = serve(Arc::new(|req: Req| {
        match req.path.split('?').next().unwrap() {
            "/api/v1/users/tasks/rounds" => Resp::json(
                200,
                json!({ "code": 0, "data": {
                    "chunks": [
                        { "event": "task-running", "kind": "acp_event", "data": "eyJ4IjoxfQ==",
                          "timestamp": 1_752_000_000_123_456_789i64, "seq": 7 },
                        { "event": "task-ended", "timestamp": 1_752_000_000_123i64, "seq": 8 }
                    ],
                    "next_cursor": "c2", "has_more": true
                } }),
            ),
            _ => Resp::json(404, json!({})),
        }
    }));
    let svc = Service::test_service(Endpoints {
        account: url.clone(),
        model_gateway: url.clone(),
        mcp_gateway: url.clone(),
        monkeycode: url,
    });
    // mc 罐需非空(代理守卫);种一个假 cookie
    svc.mc.update(
        &reqwest::Url::parse("https://monkeycode-ai.com/").unwrap(),
        &["mc_session=x; Path=/".to_string()],
    );
    let out = super::monkeycode::mc_task_rounds(&svc, "t1", "", 2).await.map_err(|e| e.msg()).unwrap();
    let frames = out.get("frames").and_then(|v| v.as_array()).unwrap();
    assert_eq!(frames.len(), 2);
    // 纳秒 → 毫秒
    assert_eq!(frames[0].get("timestamp").and_then(|v| v.as_i64()), Some(1_752_000_000_123));
    assert_eq!(frames[0].get("type").and_then(|v| v.as_str()), Some("task-running"));
    assert_eq!(frames[0].get("kind").and_then(|v| v.as_str()), Some("acp_event"));
    assert_eq!(frames[0].get("seq").and_then(|v| v.as_u64()), Some(7));
    // 已是毫秒 → 原样
    assert_eq!(frames[1].get("timestamp").and_then(|v| v.as_i64()), Some(1_752_000_000_123));
    assert!(frames[1].get("kind").is_none());
    assert_eq!(out.get("next_cursor").and_then(|v| v.as_str()), Some("c2"));
    assert_eq!(out.get("has_more").and_then(|v| v.as_bool()), Some(true));
}
