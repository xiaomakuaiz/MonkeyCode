// 微信扫码登录(agent/internal/baizhi/wechat.go 的 Rust 移植)。
// 壳扮演 qrconnect 页面的角色(网页版微信登录同款协议,多年稳定):
//
//  1. baizhi /api/v1/user/oauth/login?platform=wechat → qrconnect 授权页 URL
//  2. GET 授权页,解析出二维码 uuid(/connect/qrcode/<uuid>)
//  3. 二维码图片下发 UI 展示;长轮询 lp.<授权页域名>/connect/l/qrconnect?uuid=
//     wx_errcode: 408 待扫码 / 404 已扫码待确认 / 403 已取消 / 402|500 过期 /
//     405 确认成功(附 wx_code)
//  4. 拿到 wx_code 后,带 cookie 罐 GET 百智云回调 → 会话 cookie 落盘

use base64::Engine as _;

use super::{clean_message, other, BzResult, Service};

/// 单次扫码会话(Service 同一时刻只保留最新一次)。
pub struct WechatLogin {
    uuid: String,
    state: String,
    /// redirect_uri(不含 code/state)
    callback_url: String,
    /// 长轮询基址,如 https://lp.open.weixin.qq.com
    lp_base: String,
}

/// 发起扫码会话,返回二维码图片(data URL,UI 直接 <img>)。
pub async fn start_wechat_login(svc: &Service) -> BzResult<String> {
    // 1. 授权页地址(redirect_url 用官网首页,语义同网页登录)
    let redirect = urlencoding_encode(&format!("{}/", svc.ep.account));
    let out = svc
        .call(
            reqwest::Method::GET,
            &format!("/api/v1/user/oauth/login?platform=wechat&redirect_url={redirect}"),
            None,
        )
        .await
        .map_err(|e| other(format!("获取微信授权地址失败: {}", e.msg())))?;
    let auth_url_str = out.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let auth_url = reqwest::Url::parse(auth_url_str)
        .map_err(|_| other(format!("微信授权地址异常: {auth_url_str:?}")))?;
    let q = |name: &str| -> String {
        auth_url
            .query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default()
    };
    let state = q("state");
    let callback = q("redirect_uri");
    if state.is_empty() || callback.is_empty() {
        return Err(other(format!("微信授权地址缺少 state/redirect_uri: {auth_url_str:?}")));
    }

    // 2. 拉授权页解析二维码 uuid
    let page = svc
        .fetch(auth_url_str)
        .await
        .map_err(|e| other(format!("加载微信授权页失败: {}", e.msg())))?;
    let page_text = String::from_utf8_lossy(&page);
    let re = regex::Regex::new(r"/connect/qrcode/([A-Za-z0-9_-]+)").unwrap();
    let uuid = re
        .captures(&page_text)
        .and_then(|m| m.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| other("微信授权页里没找到二维码(页面结构可能已变化)"))?;

    // 3. 二维码图片
    let host = auth_url.host_str().unwrap_or("");
    let scheme = auth_url.scheme();
    let img = svc
        .fetch(&format!("{scheme}://{host}/connect/qrcode/{uuid}"))
        .await
        .map_err(|e| other(format!("获取微信二维码失败: {}", e.msg())))?;

    let login = WechatLogin {
        uuid,
        state,
        callback_url: callback,
        lp_base: format!("{scheme}://lp.{host}"),
    };
    *svc.wx.lock().unwrap() = Some(login);
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&img)
    ))
}

/// 长轮询一次扫码状态(微信侧最长挂 ~25s;UI 收到结果后立即再调)。
/// 确认成功时就地完成百智云回调,返回 "ok" 即已登录。
pub async fn poll_wechat_login(svc: &Service) -> BzResult<&'static str> {
    let (uuid, state, callback_url, lp_base) = {
        let wx = svc.wx.lock().unwrap();
        let login = wx.as_ref().ok_or_else(|| other("没有进行中的扫码会话,请先获取二维码"))?;
        (login.uuid.clone(), login.state.clone(), login.callback_url.clone(), login.lp_base.clone())
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let lp_url = format!("{lp_base}/connect/l/qrconnect?uuid={}&_={now_ms}", urlencoding_encode(&uuid));
    let body = svc
        .fetch(&lp_url)
        .await
        .map_err(|e| other(format!("查询扫码状态失败: {}", e.msg())))?;
    let text = String::from_utf8_lossy(&body);
    let errcode_re = regex::Regex::new(r"wx_errcode=(\d+)").unwrap();
    let errcode: i32 = errcode_re
        .captures(&text)
        .and_then(|m| m.get(1))
        .and_then(|m| m.as_str().parse().ok())
        .ok_or_else(|| other(format!("扫码状态响应异常: {}", truncate(&text, 120))))?;
    match errcode {
        408 => Ok("waiting"),
        404 => Ok("scanned"),
        403 => Ok("canceled"),
        402 | 500 => Ok("expired"),
        405 => {
            let code_re = regex::Regex::new(r"wx_code='([^']*)'").unwrap();
            let code = code_re
                .captures(&text)
                .and_then(|m| m.get(1))
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            if code.is_empty() {
                return Err(other("扫码确认成功但未返回授权码"));
            }
            complete_wechat_callback(svc, &callback_url, &state, &code).await?;
            *svc.wx.lock().unwrap() = None;
            Ok("ok")
        }
        n => Err(other(format!("未知扫码状态 wx_errcode={n}"))),
    }
}

/// 用 wx_code 走百智云回调换会话,并以 profile 探测确认。
async fn complete_wechat_callback(svc: &Service, callback_url: &str, state: &str, code: &str) -> BzResult<()> {
    let mut cb = reqwest::Url::parse(callback_url).map_err(|e| other(format!("回调地址异常: {e}")))?;
    cb.query_pairs_mut().append_pair("code", code).append_pair("state", state);
    // 回调通常 302 到 redirect_url;不跟随重定向,Set-Cookie 在首响应即被吸收。
    let (data, status) = svc
        .do_store(&svc.store, reqwest::Method::GET, cb.as_str(), None)
        .await
        .map_err(|e| other(format!("微信登录回调失败: {}", e.msg())))?;
    if status >= 400 {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&data) {
            if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
                return Err(other(format!("微信登录回调被拒: {}", clean_message(m))));
            }
        }
        return Err(other(format!("微信登录回调被拒(HTTP {status})")));
    }
    // 权威确认:会话真的建立了
    let (logged_in, _) = svc.status().await.map_err(|e| other(format!("登录状态确认失败: {}", e.msg())))?;
    if !logged_in {
        return Err(other("微信登录未生效(回调已走通但会话无效),请重试"));
    }
    Ok(())
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let cut = s.char_indices().map(|(i, _)| i).take_while(|&i| i <= n).last().unwrap_or(0);
    format!("{}...", &s[..cut])
}

/// 最小 URL 查询转义(仅字母数字与 -_.~ 保留)。
fn urlencoding_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}
