use super::{serve, Endpoints, Req, Resp, Service};
use crate::baizhi::{monkeycode, WebviewIdentity};
use base64::Engine as _;
use serde_json::json;
use std::sync::{Arc, Mutex};

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN3cAAAAASUVORK5CYII=";
const ASSET: &str = "/api/v1/assets?key=temp%2Ffrom-ws.png";

fn png() -> Resp {
    Resp {
        status: 200,
        // 裸字节上传后的 OSS 默认类型；图片读取须按真实内容识别。
        headers: vec![("Content-Type".into(), "application/octet-stream".into())],
        body: base64::engine::general_purpose::STANDARD
            .decode(PNG)
            .unwrap(),
    }
}

fn service(base: &str) -> Service {
    let mut svc = Service::test_service(Endpoints {
        account: "https://account.example.com".into(),
        model_gateway: "https://models.example.com".into(),
        mcp_gateway: "https://mcp.example.com".into(),
        monkeycode: base.into(),
    });
    svc.mc_basic = Some("Basic gateway".into());
    svc.mc.update(
        &reqwest::Url::parse(base).unwrap(),
        &["_oauth2_proxy=session; Path=/".into()],
    );
    svc.set_webview_identity(Some(WebviewIdentity {
        user_agent: "WebView/1".into(),
        accept_language: "zh-CN".into(),
    }));
    svc
}

#[tokio::test(flavor = "multi_thread")]
async fn relative_asset_read_uses_server_prefix_and_login() {
    for prefix in ["", "/private/team"] {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let captured = seen.clone();
        let (url, _stop) = serve(Arc::new(move |req: Req| {
            let authenticated = req.cookie.contains("_oauth2_proxy=session")
                && req.authorization == "Basic gateway"
                && req.user_agent == "WebView/1";
            captured.lock().unwrap().push(req);
            if authenticated {
                png().with_cookie("_oauth2_proxy=refreshed; Path=/")
            } else {
                Resp::redirect("/oauth2/start")
            }
        }));
        let svc = service(&format!("{url}{prefix}"));
        let data = monkeycode::mc_attachment_read(&svc, ASSET)
            .await
            .map_err(|e| e.msg())
            .unwrap();
        assert_eq!(data, format!("data:image/png;base64,{PNG}"));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method, "GET");
        assert_eq!(seen[0].path, format!("{prefix}{ASSET}"));
        assert_eq!(seen[0].accept_language, "zh-CN");
        assert!(svc
            .mc
            .header(&reqwest::Url::parse(&url).unwrap())
            .unwrap()
            .contains("refreshed"));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn ws_storage_url_preserves_signature_and_isolates_credentials() {
    for same_origin in [false, true] {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let captured = seen.clone();
        let (storage, _stop) = serve(Arc::new(move |req| {
            captured.lock().unwrap().push(req);
            png().with_cookie("_oauth2_proxy=storage-cookie; Path=/")
        }));
        let (other, _other_stop) = serve(Arc::new(|_| Resp::json(500, json!({}))));
        let svc = service(if same_origin { &storage } else { &other });
        let path = "/oss/from-ws.png?X-Amz-Signature=a%2Fb&X-Amz-SignedHeaders=host";
        let data = monkeycode::mc_attachment_read(&svc, &format!("{storage}{path}"))
            .await
            .map_err(|e| e.msg())
            .unwrap();
        assert_eq!(data, format!("data:image/png;base64,{PNG}"));
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].path, path);
        assert!(seen[0].authorization.is_empty(), "存储签名不能混入 Basic");
        assert_eq!(!seen[0].cookie.is_empty(), same_origin);
        assert_eq!(!seen[0].user_agent.is_empty(), same_origin);
        let cookie = svc
            .mc
            .header(&reqwest::Url::parse(&svc.ep.monkeycode).unwrap())
            .unwrap();
        assert_eq!(cookie.contains("storage-cookie"), same_origin);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn attachment_read_rejects_login_html_and_oversized_body() {
    let (url, _stop) = serve(Arc::new(|req| {
        if req.path.contains("large") {
            Resp {
                status: 200,
                headers: vec![],
                body: vec![0; 20 * 1024 * 1024 + 1],
            }
        } else {
            Resp {
                status: 200,
                headers: vec![("Content-Type".into(), "text/html".into())],
                body: b"<html>Sign in</html>".to_vec(),
            }
        }
    }));
    let svc = service(&url);
    for (path, expected) in [
        (ASSET, "图片格式"),
        ("/api/v1/assets?key=large.png", "20MB"),
    ] {
        let error = monkeycode::mc_attachment_read(&svc, path)
            .await
            .err()
            .expect("必须拒绝")
            .msg();
        assert!(error.contains(expected), "{error}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn attachment_read_does_not_follow_redirects() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = seen.clone();
    let (other, _other_stop) = serve(Arc::new(move |req| {
        captured.lock().unwrap().push(req);
        png()
    }));
    let (url, _stop) = serve(Arc::new(move |_| Resp::redirect(&other)));
    assert!(monkeycode::mc_attachment_read(&service(&url), ASSET)
        .await
        .is_err());
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn attachment_read_discards_late_image_after_logout() {
    let current: Arc<Mutex<Option<Arc<Service>>>> = Arc::new(Mutex::new(None));
    let captured = current.clone();
    let (url, _stop) = serve(Arc::new(move |_| {
        let svc = captured.lock().unwrap().as_ref().unwrap().clone();
        let _next = svc.logged_out();
        png()
    }));
    let svc = Arc::new(service(&url));
    *current.lock().unwrap() = Some(svc.clone());
    let error = monkeycode::mc_attachment_read(&svc, ASSET)
        .await
        .err()
        .expect("旧图片必须被丢弃")
        .msg();
    assert!(error.contains("已取消"), "{error}");
}

#[tokio::test(flavor = "multi_thread")]
async fn attachment_read_rejects_non_http_sources() {
    let svc = service("https://mc.example.com");
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hello",
        "//evil.example/a.png",
        "/\\evil.example/a.png",
        "https://user:pass@mc.example.com/a.png",
    ] {
        assert!(
            monkeycode::mc_attachment_read(&svc, url).await.is_err(),
            "{url}"
        );
    }
}
