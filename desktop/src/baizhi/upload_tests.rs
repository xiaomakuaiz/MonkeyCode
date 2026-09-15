// 真 HTTP 请求覆盖 presign → PUT 与 multipart 两条上传路径。
use super::{serve, Endpoints, Req, Resp, Service};
use crate::baizhi::{monkeycode, WebviewIdentity};
use serde_json::json;
use std::sync::{Arc, Mutex};

const USER_AGENT: &str = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15";
const LANGUAGE: &str = "zh-CN,zh;q=0.9";
const OBJECT_PATH: &str = "/oss/private/test.txt?X-Amz-Signature=a%2Fb&X-Amz-SignedHeaders=host";

fn service(base: &str) -> Service {
    let mut svc = Service::test_service(Endpoints {
        account: "https://account.example.com".into(),
        model_gateway: "https://models.example.com".into(),
        mcp_gateway: "https://mcp.example.com".into(),
        monkeycode: base.into(),
    });
    svc.mc_basic = super::super::basic_header_value("user:pass");
    svc.mc.update(
        &reqwest::Url::parse(base).unwrap(),
        &[
            "mc_session=session; Path=/".into(),
            "_oauth2_proxy=login; Path=/".into(),
            "api_only=private; Path=/api/".into(),
        ],
    );
    svc.set_webview_identity(Some(WebviewIdentity {
        user_agent: USER_AGENT.into(),
        accept_language: LANGUAGE.into(),
    }));
    svc
}

#[tokio::test(flavor = "multi_thread")]
async fn mc_upload_uses_gateway_session() {
    let base = Arc::new(Mutex::new(String::new()));
    let server_base = base.clone();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = seen.clone();
    let (url, _stop) = serve(Arc::new(move |req: Req| {
        let response = if req.path == "/api/v1/uploader/presign" {
            Resp::json(
                200,
                json!({ "code": 0, "data": {
                    "upload_url": format!("{}{OBJECT_PATH}", server_base.lock().unwrap()),
                    "access_url": "/api/v1/uploader/asset/test.txt",
                }}),
            )
            .with_cookie("_oauth2_proxy=presign-refreshed; Path=/; HttpOnly")
        } else if req.path == OBJECT_PATH {
            // 模拟绑定浏览器身份的 OAuth 网关：缺 Cookie 或身份头即弹登录页。
            if !req.cookie.contains("_oauth2_proxy=presign-refreshed")
                || req.user_agent != USER_AGENT
                || req.accept_language != LANGUAGE
            {
                Resp::redirect("/oauth2/start")
            } else if !req.authorization.is_empty() {
                Resp::json(
                    400,
                    json!({ "message": "multiple authentication mechanisms" }),
                )
            } else {
                Resp {
                    status: 204,
                    headers: vec![],
                    body: vec![],
                }
                .with_cookie("_oauth2_proxy=upload-refreshed; Path=/; HttpOnly")
            }
        } else {
            Resp::json(200, json!({ "code": 0, "data": { "projects": [] } }))
        };
        captured.lock().unwrap().push(req);
        response
    }));
    *base.lock().unwrap() = url.clone();
    let svc = service(&url);
    let payload = b"file bytes\0\xff".to_vec();

    let access_url = monkeycode::mc_upload(&svc, "test.txt", payload.clone())
        .await
        .map_err(|e| e.msg())
        .unwrap();
    assert_eq!(access_url, "/api/v1/uploader/asset/test.txt");
    monkeycode::mc_projects(&svc)
        .await
        .map_err(|e| e.msg())
        .unwrap();

    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].content_type, "application/json");
    assert!(requests[0].cookie.contains("_oauth2_proxy=login"));
    assert_eq!(requests[0].authorization, "Basic dXNlcjpwYXNz");
    assert_eq!(requests[1].method, "PUT");
    assert_eq!(requests[1].body, payload);
    assert_eq!(requests[1].path, OBJECT_PATH, "不得改写预签名查询串");
    assert!(requests[1].cookie.contains("mc_session=session"));
    assert!(
        !requests[1].cookie.contains("api_only="),
        "Cookie Path 仍须匹配"
    );
    assert!(
        requests[1].authorization.is_empty(),
        "预签名 PUT 不追加 Basic"
    );
    assert!(
        requests[1].content_type.is_empty(),
        "裸字节上传不自动追加 Content-Type"
    );
    assert!(
        requests[2]
            .cookie
            .contains("_oauth2_proxy=upload-refreshed"),
        "上传响应刷新会话后，普通 API 立即使用新 Cookie"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn mc_upload_keeps_external_storage_isolated() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = seen.clone();
    let (storage_url, _storage_stop) = serve(Arc::new(move |req: Req| {
        captured.lock().unwrap().push(req);
        Resp {
            status: 204,
            headers: vec![],
            body: vec![],
        }
        .with_cookie("_oauth2_proxy=external; Path=/")
    }));
    let upload_url = format!("{storage_url}{OBJECT_PATH}");
    let (mc_url, _mc_stop) = serve(Arc::new(move |_req: Req| {
        Resp::json(
            200,
            json!({ "code": 0, "data": {
                "upload_url": upload_url,
                "access_url": "https://storage.example.com/test.txt",
            }}),
        )
    }));
    let svc = service(&mc_url);
    // 两个服务同主机、不同端口，Cookie 自身的域规则会匹配；必须另做同源限制。
    assert!(svc
        .mc
        .header(&reqwest::Url::parse(&storage_url).unwrap())
        .is_some());
    let result = monkeycode::mc_upload(&svc, "test.txt", b"hello".to_vec())
        .await
        .map_err(|e| e.msg())
        .unwrap();
    assert_eq!(result, "https://storage.example.com/test.txt");
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "PUT");
    assert_eq!(requests[0].path, OBJECT_PATH);
    assert_eq!(requests[0].body, b"hello");
    assert!(requests[0].cookie.is_empty());
    assert!(requests[0].authorization.is_empty());
    assert!(requests[0].content_type.is_empty());
    assert!(requests[0].user_agent.is_empty());
    assert!(requests[0].accept_language.is_empty());
    let cookie = svc
        .mc
        .header(&reqwest::Url::parse(&mc_url).unwrap())
        .unwrap();
    assert!(
        cookie.contains("_oauth2_proxy=login"),
        "外部上传响应不得改写本站会话"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn mc_upload_does_not_follow_redirects() {
    let redirected = Arc::new(Mutex::new(Vec::new()));
    let captured = redirected.clone();
    let (other, _other_stop) = serve(Arc::new(move |req: Req| {
        captured.lock().unwrap().push(req);
        Resp::json(200, json!({}))
    }));
    let base = Arc::new(Mutex::new(String::new()));
    let server_base = base.clone();
    let (url, _stop) = serve(Arc::new(move |req: Req| {
        if req.path == "/api/v1/uploader/presign" {
            Resp::json(
                200,
                json!({ "code": 0, "data": {
                    "upload_url": format!("{}{OBJECT_PATH}", server_base.lock().unwrap()),
                    "access_url": "/asset/test.txt",
                }}),
            )
        } else {
            let mut response = Resp::redirect(&other);
            response.status = 307; // 307 若被跟随，会连同文件内容重新 PUT。
            response
        }
    }));
    *base.lock().unwrap() = url.clone();
    let result = monkeycode::mc_upload(&service(&url), "test.txt", b"hello".to_vec()).await;
    assert!(result.is_err(), "重定向不得当成上传成功");
    assert!(
        redirected.lock().unwrap().is_empty(),
        "不得跟随跳转转发文件或凭证"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn mc_file_upload_shares_session_refresh() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = seen.clone();
    let (url, _stop) = serve(Arc::new(move |req: Req| {
        let response = if req.path.starts_with("/api/v1/users/files/upload?") {
            Resp::json(200, json!({ "code": 0, "data": {} }))
                .with_cookie("_oauth2_proxy=workspace-refreshed; Path=/")
        } else {
            Resp::json(200, json!({ "code": 0, "data": { "projects": [] } }))
        };
        captured.lock().unwrap().push(req);
        response
    }));
    let svc = service(&url);
    monkeycode::mc_file_upload(&svc, "vm1", "/workspace/test.txt", b"hello".to_vec())
        .await
        .map_err(|e| e.msg())
        .unwrap();
    monkeycode::mc_projects(&svc)
        .await
        .map_err(|e| e.msg())
        .unwrap();
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, "POST");
    assert!(requests[0].cookie.contains("_oauth2_proxy=login"));
    assert_eq!(requests[0].authorization, "Basic dXNlcjpwYXNz");
    assert_eq!(requests[0].user_agent, USER_AGENT);
    assert_eq!(requests[0].accept_language, LANGUAGE);
    assert!(requests[0]
        .content_type
        .starts_with("multipart/form-data; boundary="));
    let multipart = String::from_utf8_lossy(&requests[0].body);
    assert!(multipart.contains("name=\"file\"; filename=\"test.txt\""));
    assert!(multipart.contains("\r\n\r\nhello\r\n"));
    assert!(requests[1]
        .cookie
        .contains("_oauth2_proxy=workspace-refreshed"));
}

#[test]
fn mc_credentials_and_tls_exception_require_same_origin() {
    let mut svc = service("https://mc.example.com");
    svc.mc_skip_tls = true;
    for (target, same_origin) in [
        ("https://mc.example.com/oss/a", true),
        ("https://mc.example.com:443/oss/a", true),
        ("https://mc.example.com:8443/oss/a", false),
        ("http://mc.example.com:443/oss/a", false),
        ("http://mc.example.com/oss/a", false),
        ("https://storage.mc.example.com/oss/a", false),
        ("https://other.example.com/oss/a", false),
    ] {
        let url = reqwest::Url::parse(target).unwrap();
        assert_eq!(svc.is_mc_url(&url), same_origin, "{target}");
        assert_eq!(svc.mc_basic_header(&url).is_some(), same_origin, "{target}");
        assert_eq!(
            !svc.mc_identity_headers(&url).is_empty(),
            same_origin,
            "{target}"
        );
        assert_eq!(svc.tls_insecure_for(&url), same_origin, "{target}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn mc_upload_cannot_restore_session_after_logout() {
    let active: Arc<Mutex<Option<Arc<Service>>>> = Arc::new(Mutex::new(None));
    let server_active = active.clone();
    let (url, _stop) = serve(Arc::new(move |req: Req| {
        let svc = server_active.lock().unwrap().as_ref().unwrap().clone();
        if req.path == "/api/v1/uploader/presign" {
            Resp::json(
                200,
                json!({ "code": 0, "data": {
                    "upload_url": format!("{}{OBJECT_PATH}", svc.ep.monkeycode),
                    "access_url": "/asset/test.txt",
                }}),
            )
        } else {
            // 请求已送达、响应尚未返回时登出，推进真实 Cookie 代次守卫。
            let _next_service = svc.logged_out();
            Resp {
                status: 204,
                headers: vec![],
                body: vec![],
            }
            .with_cookie("_oauth2_proxy=stale; Path=/")
        }
    }));
    let svc = Arc::new(service(&url));
    *active.lock().unwrap() = Some(svc.clone());
    monkeycode::mc_upload(&svc, "test.txt", b"hello".to_vec())
        .await
        .map_err(|e| e.msg())
        .unwrap();
    assert!(svc.mc.is_empty(), "迟到的上传响应不能恢复已退出的登录态");
}

#[tokio::test(flavor = "multi_thread")]
async fn mc_upload_stops_after_service_switch() {
    let new_requests = Arc::new(Mutex::new(Vec::new()));
    let new_captured = new_requests.clone();
    let (new_url, _new_stop) = serve(Arc::new(move |req| {
        new_captured.lock().unwrap().push(req);
        Resp::json(200, json!({ "code": 0, "data": { "projects": [] } }))
    }));
    let active: Arc<Mutex<Option<Arc<Service>>>> = Arc::new(Mutex::new(None));
    let server_active = active.clone();
    let current: Arc<Mutex<Option<Arc<Service>>>> = Arc::new(Mutex::new(None));
    let current_in_handler = current.clone();
    let uploads = Arc::new(Mutex::new(Vec::new()));
    let captured = uploads.clone();
    let (old_url, _old_stop) = serve(Arc::new(move |req: Req| {
        let old = server_active.lock().unwrap().as_ref().unwrap().clone();
        if req.path == "/api/v1/uploader/presign" {
            // 旧预签名尚未返回时，切到同主机的另一个端口并登录新服务。
            // Cookie 不区分端口；旧实现随后 PUT 时会读到 new-service-only。
            let (next, changed) = old.reconfigured(&crate::config::DesktopConfig {
                mc_base_url: new_url.clone(),
                ..Default::default()
            });
            assert!(changed);
            let next_url = reqwest::Url::parse(&next.ep.monkeycode).unwrap();
            assert!(!next.is_mc_url(&reqwest::Url::parse(&old.ep.monkeycode).unwrap()));
            assert!(next.absorb_mc_cookies(
                &next_url,
                &["_oauth2_proxy=new-service-only; Path=/".into(),]
            ));
            *current_in_handler.lock().unwrap() = Some(Arc::new(next));
            Resp::json(
                200,
                json!({ "code": 0, "data": {
                    "upload_url": format!("{}{OBJECT_PATH}", old.ep.monkeycode),
                    "access_url": "/asset/test.txt",
                }}),
            )
        } else {
            captured.lock().unwrap().push(req);
            Resp {
                status: 204,
                headers: vec![],
                body: vec![],
            }
        }
    }));
    let old = Arc::new(service(&old_url));
    *active.lock().unwrap() = Some(old.clone());
    let error = monkeycode::mc_upload(&old, "test.txt", b"hello".to_vec())
        .await
        .err()
        .expect("旧上传必须取消")
        .msg();
    assert!(error.contains("已取消"), "{error}");
    assert!(
        uploads.lock().unwrap().is_empty(),
        "旧服务不得收到后续 PUT、文件或新凭证"
    );
    let next = current.lock().unwrap().as_ref().unwrap().clone();
    monkeycode::mc_projects(&next)
        .await
        .map_err(|e| e.msg())
        .unwrap();
    let new_requests = new_requests.lock().unwrap();
    assert_eq!(new_requests.len(), 1);
    assert!(
        new_requests[0]
            .cookie
            .contains("_oauth2_proxy=new-service-only"),
        "新服务的有效会话不受旧上传取消影响"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn mc_upload_stops_after_logout_before_put() {
    for external_storage in [false, true] {
        let uploads = Arc::new(Mutex::new(Vec::new()));
        let external_captured = uploads.clone();
        let (storage_url, _storage_stop) = serve(Arc::new(move |req| {
            external_captured.lock().unwrap().push(req);
            Resp {
                status: 204,
                headers: vec![],
                body: vec![],
            }
        }));
        let active: Arc<Mutex<Option<Arc<Service>>>> = Arc::new(Mutex::new(None));
        let server_active = active.clone();
        let captured = uploads.clone();
        let (url, _stop) = serve(Arc::new(move |req: Req| {
            let old = server_active.lock().unwrap().as_ref().unwrap().clone();
            if req.path == "/api/v1/uploader/presign" {
                let _next = old.logged_out();
                let base = if external_storage {
                    &storage_url
                } else {
                    &old.ep.monkeycode
                };
                Resp::json(
                    200,
                    json!({ "code": 0, "data": {
                        "upload_url": format!("{base}{OBJECT_PATH}"),
                        "access_url": "/asset/test.txt",
                    }}),
                )
            } else {
                captured.lock().unwrap().push(req);
                Resp {
                    status: 204,
                    headers: vec![],
                    body: vec![],
                }
            }
        }));
        let old = Arc::new(service(&url));
        *active.lock().unwrap() = Some(old.clone());
        let error = monkeycode::mc_upload(&old, "test.txt", b"hello".to_vec())
            .await
            .err()
            .expect("登出后必须取消后续上传")
            .msg();
        assert!(error.contains("已取消"), "{error}");
        assert!(
            uploads.lock().unwrap().is_empty(),
            "同源与外部存储都不能继续接收旧任务的 PUT"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stale_mc_snapshot_does_not_disable_baizhi_session() {
    let mc_requests = Arc::new(Mutex::new(Vec::new()));
    let captured = mc_requests.clone();
    let (mc_url, _mc_stop) = serve(Arc::new(move |req| {
        captured.lock().unwrap().push(req);
        Resp::json(200, json!({ "code": 0, "data": {} }))
    }));
    let bz_requests = Arc::new(Mutex::new(Vec::new()));
    let bz_captured = bz_requests.clone();
    let (bz_url, _bz_stop) = serve(Arc::new(move |req| {
        bz_captured.lock().unwrap().push(req);
        Resp::json(200, json!({ "code": 0, "data": { "name": "百智用户" } }))
    }));
    let mut old = service(&mc_url);
    old.ep.account = bz_url.clone();
    old.store.update(
        &reqwest::Url::parse(&bz_url).unwrap(),
        &["baizhi_session=active; Path=/".into()],
    );
    let _next = old.logged_out();

    assert!(monkeycode::mc_projects(&old).await.is_err());
    assert!(
        monkeycode::mc_file_upload(&old, "vm1", "/workspace/test.txt", b"hello".to_vec())
            .await
            .is_err()
    );
    assert!(
        crate::baizhi::weblogin::probe_status(&old, "_oauth2_proxy=old")
            .await
            .is_err()
    );
    assert!(
        mc_requests.lock().unwrap().is_empty(),
        "普通 MC 请求、文件上传与旧登录探测都应在发出前被拒绝"
    );

    let profile = old
        .call(reqwest::Method::GET, "/api/v1/user/profile", None)
        .await
        .map_err(|e| e.msg())
        .unwrap();
    assert_eq!(profile["name"], "百智用户");
    let requests = bz_requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].cookie, "baizhi_session=active");
}
