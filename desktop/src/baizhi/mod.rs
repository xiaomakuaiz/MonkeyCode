// 百智云账号 + MonkeyCode 云端(agent/internal/baizhi 的 Rust 移植)。
// 壳级单例,与 agent 引擎无关(切到 ohmyagent 云端功能照常)。
// 凭证(cookie)只在壳进程内,UI 经 Tauri IPC 驱动。

pub mod cookies;
pub mod monkeycode;
pub mod pow;
pub mod sync;
pub mod wechat;

#[cfg(test)]
mod tests;

use std::sync::Mutex as StdMutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::State;

use cookies::CookieStore;

/// 百智云的四个可配地址。私有化部署时都会变,独立可配,默认官方云。
/// 优先级:环境变量 > 默认。
pub struct Endpoints {
    /// 账号/登录域(验证码、手机号/微信登录、profile)
    pub account: String,
    /// 模型网关:/api/console/* 取 key 与模型列表;/api/openai、/api/anthropic 为推理 base_url
    pub model_gateway: String,
    /// Agent 工具包(MCP 服务)
    pub mcp_gateway: String,
    /// MonkeyCode 云端(账号桥接登录 + 云端任务)
    pub monkeycode: String,
}

fn env_or(env: &str, def: &str) -> String {
    std::env::var(env)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| def.to_string())
        .trim_end_matches('/')
        .to_string()
}

impl Endpoints {
    pub fn resolve() -> Self {
        Self {
            account: env_or("MC_DESKTOP_BAIZHI_URL", "https://baizhi.cloud"),
            model_gateway: env_or("MC_DESKTOP_BAIZHI_MODEL_GATEWAY", "https://ai-api-gateway.app.baizhi.cloud"),
            mcp_gateway: env_or("MC_DESKTOP_BAIZHI_MCP_GATEWAY", "https://agent-toolkit.app.baizhi.cloud"),
            monkeycode: env_or("MC_DESKTOP_MONKEYCODE_URL", "https://monkeycode-ai.com"),
        }
    }
}

/// 会话失效哨兵:Status 类接口转成"未登录"而非报错;错误信息透传 UI。
pub enum BzErr {
    Unauthorized(String),
    Other(String),
}

impl BzErr {
    pub fn msg(self) -> String {
        match self {
            BzErr::Unauthorized(m) | BzErr::Other(m) => m,
        }
    }
}

pub type BzResult<T> = Result<T, BzErr>;

pub fn other(m: impl Into<String>) -> BzErr {
    BzErr::Other(m.into())
}

/// 百智云账号服务。cookie 分双罐:百智会话(store)与 MonkeyCode 会话(mc),
/// 凭证语义不同,一方登出不牵连另一方。
pub struct Service {
    pub ep: Endpoints,
    /// API 短请求(30s;不自动跟随重定向——微信回调等 302 的 Set-Cookie
    /// 要在首响应就吸收,跟随会丢中间响应的 cookie)
    http: reqwest::Client,
    /// 微信授权页/二维码/长轮询(长轮询最长挂 ~25s)
    lp: reqwest::Client,
    pub store: CookieStore,
    pub mc: CookieStore,
    /// 进行中的扫码会话(只保留最新)
    pub wx: StdMutex<Option<wechat::WechatLogin>>,
}

impl Service {
    /// 测试构造:端点可注入,cookie 仅内存。
    #[cfg(test)]
    pub fn test_service(ep: Endpoints) -> Self {
        let mk = |timeout: u64| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(timeout))
                .build()
                .expect("构建 HTTP 客户端失败")
        };
        Self {
            ep,
            http: mk(10),
            lp: mk(10),
            store: CookieStore::new(None),
            mc: CookieStore::new(None),
            wx: StdMutex::new(None),
        }
    }

    pub fn new(config_dir: std::path::PathBuf) -> Self {
        let mk = |timeout: u64| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(timeout))
                .build()
                .expect("构建 HTTP 客户端失败")
        };
        Self {
            ep: Endpoints::resolve(),
            http: mk(30),
            lp: mk(40),
            store: CookieStore::new(Some(config_dir.join("baizhi-cookies.json"))),
            mc: CookieStore::new(Some(config_dir.join("monkeycode-cookies.json"))),
            wx: StdMutex::new(None),
        }
    }

    // ==================== HTTP 基座 ====================

    /// 发请求:携带指定罐的 cookie,吸收响应的 Set-Cookie。
    /// 返回 (body, status, Location 头)——桥接登录手动跟随重定向需要 Location。
    pub async fn do_store_full(
        &self,
        store: &CookieStore,
        method: reqwest::Method,
        target: &str,
        body: Option<&Value>,
    ) -> BzResult<(Vec<u8>, u16, Option<String>)> {
        let url = reqwest::Url::parse(target).map_err(|e| other(format!("地址异常: {e}")))?;
        let host = url.host_str().unwrap_or("").to_string();
        let mut req = self.http.request(method, url.clone());
        if let Some(b) = body {
            req = req.json(b);
        }
        if let Some(h) = store.header(&url) {
            req = req.header(reqwest::header::COOKIE, h);
        }
        let resp = req.send().await.map_err(|e| other(format!("请求 {host} 失败: {e}")))?;
        let status = resp.status().as_u16();
        let location = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let set_cookies: Vec<String> = resp
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_string))
            .collect();
        store.update(resp.url(), &set_cookies);
        let data = resp.bytes().await.map_err(|e| other(format!("读取响应失败: {e}")))?;
        Ok((data.to_vec(), status, location))
    }

    /// do_store_full 的常用形态(不关心 Location)。
    pub async fn do_store(
        &self,
        store: &CookieStore,
        method: reqwest::Method,
        target: &str,
        body: Option<&Value>,
    ) -> BzResult<(Vec<u8>, u16)> {
        let (data, status, _) = self.do_store_full(store, method, target, body).await?;
        Ok((data, status))
    }

    /// 账号域相对路径请求(绝对 URL 直接用)。
    async fn account_do(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> BzResult<(Vec<u8>, u16)> {
        let target = if path.starts_with("http://") || path.starts_with("https://") {
            path.to_string()
        } else {
            format!("{}{}", self.ep.account, path)
        };
        self.do_store(&self.store, method, &target, body).await
    }

    /// GET 任意 URL(百智罐;微信页面/图片/长轮询走这里,超时 40s)。
    pub async fn fetch(&self, raw_url: &str) -> BzResult<Vec<u8>> {
        let url = reqwest::Url::parse(raw_url).map_err(|e| other(format!("地址异常: {e}")))?;
        let mut req = self.lp.get(url.clone());
        if let Some(h) = self.store.header(&url) {
            req = req.header(reqwest::header::COOKIE, h);
        }
        let resp = req.send().await.map_err(|e| other(format!("请求失败: {e}")))?;
        let status = resp.status().as_u16();
        let set_cookies: Vec<String> = resp
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_string))
            .collect();
        self.store.update(resp.url(), &set_cookies);
        if status >= 400 {
            return Err(other(format!("HTTP {status}")));
        }
        resp.bytes().await.map(|b| b.to_vec()).map_err(|e| other(format!("读取响应失败: {e}")))
    }

    /// 请求百智云业务接口并解开 {code,message,success,data} 包壳。
    /// 返回 data(缺 data 字段时返回整个响应体,对齐移动端语义)。
    pub async fn call(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> BzResult<Value> {
        let (data, status) = self.account_do(method, path, body).await?;
        envelope_unwrap(&data, status, "百智云")
    }

    /// 请求裸结构端点(验证码 challenge/redeem 不套包壳;2xx 即成功)。
    pub async fn call_raw(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> BzResult<Value> {
        let (data, status) = self.account_do(method, path, body).await?;
        if !(200..300).contains(&status) {
            if let Ok(v) = serde_json::from_slice::<Value>(&data) {
                if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
                    return Err(other(clean_message(m)));
                }
            }
            return Err(http_error(status, &data, "百智云"));
        }
        serde_json::from_slice(&data).map_err(|e| other(format!("百智云响应解析失败: {e}")))
    }

    // ==================== 登录/状态 ====================

    /// 完整跑一遍 PoW 验证码,返回登录接口所需 captcha_token。
    async fn obtain_captcha_token(&self) -> BzResult<String> {
        let ch = self
            .call_raw(reqwest::Method::POST, "/api/v1/public/captcha/challenge", None)
            .await
            .map_err(|e| other(format!("获取验证码质询失败: {}", e.msg())))?;
        let token = ch.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let challenge: pow::Challenge = serde_json::from_value(ch.get("challenge").cloned().unwrap_or(Value::Null))
            .map_err(|_| other("验证码质询响应格式异常"))?;
        if token.is_empty() || challenge.c == 0 {
            return Err(other("验证码质询响应格式异常"));
        }
        // SHA-256 爆破是 CPU 密集,丢 blocking 池
        let tk = token.clone();
        let solutions = tauri::async_runtime::spawn_blocking(move || pow::solve_challenges(&tk, challenge))
            .await
            .map_err(|e| other(format!("验证码求解失败: {e}")))?
            .map_err(other)?;
        let rd = self
            .call_raw(
                reqwest::Method::POST,
                "/api/v1/public/captcha/redeem",
                Some(&json!({ "token": token, "solutions": solutions })),
            )
            .await
            .map_err(|e| other(format!("验证码校验失败: {}", e.msg())))?;
        let ok = rd.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
        let rd_token = rd.get("token").and_then(|v| v.as_str()).unwrap_or("");
        if !ok || rd_token.is_empty() {
            let msg = rd.get("message").and_then(|v| v.as_str()).unwrap_or("验证码校验未通过");
            return Err(other(clean_message(msg)));
        }
        Ok(rd_token.to_string())
    }

    /// 发送登录短信验证码(内部先完成 PoW 验证码)。
    pub async fn send_phone_code(&self, phone: &str) -> BzResult<()> {
        let captcha = self.obtain_captcha_token().await?;
        self.call(
            reqwest::Method::POST,
            "/api/v1/user/phone_code",
            Some(&json!({ "phone": phone, "kind": "login", "captcha_token": captcha })),
        )
        .await
        .map(|_| ())
    }

    /// 手机号 + 短信验证码登录;成功后会话 cookie 已持久化。
    pub async fn login_phone(&self, phone: &str, code: &str) -> BzResult<()> {
        let captcha = self.obtain_captcha_token().await?;
        self.call(
            reqwest::Method::POST,
            "/api/v1/user/login/phone",
            Some(&json!({ "phone": phone, "code": code, "captcha_token": captcha })),
        )
        .await
        .map(|_| ())
    }

    /// 会话状态:有 cookie 时探测 profile,200 视为已登录并返回原样 profile。
    pub async fn status(&self) -> BzResult<(bool, Value)> {
        if self.store.is_empty() {
            return Ok((false, Value::Null));
        }
        match self.call(reqwest::Method::GET, "/api/v1/user/profile", None).await {
            Ok(profile) => Ok((true, profile)),
            Err(BzErr::Unauthorized(_)) => Ok((false, Value::Null)),
            Err(e) => Err(e),
        }
    }

    /// 账号域主机名(诊断展示用)。
    pub fn base_host(&self) -> String {
        reqwest::Url::parse(&self.ep.account)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| self.ep.account.clone())
    }
}

// ==================== 包壳/错误辅助 ====================

/// 解开 {code,message,success,data} 包壳:code!=0 或 success=false 或非 2xx 即失败。
fn envelope_unwrap(data: &[u8], status: u16, label: &str) -> BzResult<Value> {
    let is2xx = (200..300).contains(&status);
    let Ok(v) = serde_json::from_slice::<Value>(data) else {
        if is2xx {
            return Ok(Value::Null); // 非 JSON 但 2xx,视为成功无数据
        }
        return Err(http_error(status, data, label));
    };
    let code_fail = v.get("code").and_then(|c| c.as_i64()).map(|c| c != 0).unwrap_or(false);
    let success_fail = v.get("success").and_then(|s| s.as_bool()).map(|s| !s).unwrap_or(false);
    if !is2xx || code_fail || success_fail {
        let msg = clean_message(v.get("message").and_then(|m| m.as_str()).unwrap_or(""));
        if msg.is_empty() {
            return Err(http_error(status, &[], label));
        }
        if status == 401 {
            return Err(BzErr::Unauthorized(msg));
        }
        return Err(other(msg));
    }
    match v.get("data") {
        Some(d) if !d.is_null() => Ok(d.clone()),
        _ => Ok(v),
    }
}

/// 去掉服务端 message 尾部的 trace_id 标注(对齐移动端)。
pub fn clean_message(msg: &str) -> String {
    let re = regex::Regex::new(r"(?i)\s*\[trace_id:[^\]]+\]\s*$").unwrap();
    re.replace(msg, "").trim().to_string()
}

pub fn http_error(status: u16, body: &[u8], label: &str) -> BzErr {
    if status == 401 {
        return BzErr::Unauthorized(format!("{label}会话已失效,请重新登录"));
    }
    let text = String::from_utf8_lossy(body);
    let text = text.trim();
    if !text.is_empty() && text.len() <= 200 && !text.starts_with('<') {
        other(format!("{label}请求失败(HTTP {status}): {text}"))
    } else {
        other(format!("{label}请求失败(HTTP {status})"))
    }
}

// ==================== Tauri 命令 ====================

pub struct BaizhiState(pub std::sync::Arc<Service>);

fn valid_phone(p: &str) -> bool {
    p.len() == 11 && p.starts_with('1') && p.bytes().all(|b| b.is_ascii_digit()) && (b'3'..=b'9').contains(&p.as_bytes()[1])
}

fn valid_code(c: &str) -> bool {
    (4..=6).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_digit())
}

#[tauri::command]
pub async fn baizhi_status(bz: State<'_, BaizhiState>) -> Result<Value, String> {
    let (logged_in, profile) = bz.0.status().await.map_err(BzErr::msg)?;
    let mut resp = json!({ "logged_in": logged_in, "host": bz.0.base_host() });
    if !profile.is_null() {
        resp["profile"] = profile;
    }
    Ok(resp)
}

#[tauri::command]
pub async fn baizhi_send_code(bz: State<'_, BaizhiState>, phone: String) -> Result<Value, String> {
    if !valid_phone(&phone) {
        return Err("请输入有效的手机号".into());
    }
    bz.0.send_phone_code(&phone).await.map_err(BzErr::msg)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn baizhi_login(bz: State<'_, BaizhiState>, phone: String, code: String) -> Result<Value, String> {
    if !valid_phone(&phone) || !valid_code(&code) {
        return Err("请输入有效的手机号和短信验证码".into());
    }
    bz.0.login_phone(&phone, &code).await.map_err(BzErr::msg)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn baizhi_logout(bz: State<'_, BaizhiState>) -> Result<Value, String> {
    bz.0.store.clear();
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn baizhi_wechat_start(bz: State<'_, BaizhiState>) -> Result<Value, String> {
    let qr = wechat::start_wechat_login(&bz.0).await.map_err(BzErr::msg)?;
    Ok(json!({ "qr": qr }))
}

#[tauri::command]
pub async fn baizhi_wechat_poll(bz: State<'_, BaizhiState>) -> Result<Value, String> {
    let status = wechat::poll_wechat_login(&bz.0).await.map_err(BzErr::msg)?;
    Ok(json!({ "status": status }))
}

#[tauri::command]
pub async fn baizhi_sync(bz: State<'_, BaizhiState>, known_keys: Option<Vec<String>>) -> Result<Value, String> {
    sync::sync(&bz.0, &known_keys.unwrap_or_default()).await.map_err(BzErr::msg)
}

#[tauri::command]
pub async fn mc_status(bz: State<'_, BaizhiState>) -> Result<Value, String> {
    let (logged_in, user) = monkeycode::mc_status(&bz.0).await.map_err(BzErr::msg)?;
    let mut resp = json!({ "logged_in": logged_in, "host": monkeycode::mc_host(&bz.0) });
    if !user.is_null() {
        resp["user"] = user;
    }
    Ok(resp)
}

#[tauri::command]
pub async fn mc_login(bz: State<'_, BaizhiState>) -> Result<Value, String> {
    let user = monkeycode::login_monkeycode(&bz.0).await.map_err(BzErr::msg)?;
    let mut resp = json!({ "ok": true });
    if !user.is_null() {
        resp["user"] = user;
    }
    Ok(resp)
}

#[tauri::command]
pub async fn mc_logout(bz: State<'_, BaizhiState>) -> Result<Value, String> {
    bz.0.mc.clear();
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn mc_tasks(bz: State<'_, BaizhiState>, page: u32, size: u32, status: Option<String>) -> Result<Value, String> {
    let size = size.clamp(1, 50);
    let page = page.max(1);
    monkeycode::mc_tasks(&bz.0, page, size, status.as_deref().unwrap_or(""))
        .await
        .map_err(BzErr::msg)
}

#[tauri::command]
pub async fn mc_task_info(bz: State<'_, BaizhiState>, id: String) -> Result<Value, String> {
    monkeycode::mc_task_info(&bz.0, &id).await.map_err(BzErr::msg)
}

#[tauri::command]
pub async fn mc_task_rounds(
    bz: State<'_, BaizhiState>,
    id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let limit = limit.unwrap_or(1).clamp(1, 10);
    monkeycode::mc_task_rounds(&bz.0, &id, cursor.as_deref().unwrap_or(""), limit)
        .await
        .map_err(BzErr::msg)
}

#[tauri::command]
pub async fn mc_task_stop(bz: State<'_, BaizhiState>, id: String) -> Result<Value, String> {
    monkeycode::mc_task_stop(&bz.0, &id).await.map_err(BzErr::msg)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn mc_task_create(bz: State<'_, BaizhiState>, req: Value) -> Result<Value, String> {
    monkeycode::mc_task_create(&bz.0, &req).await.map_err(BzErr::msg)
}

#[tauri::command]
pub async fn mc_task_options(bz: State<'_, BaizhiState>) -> Result<Value, String> {
    monkeycode::mc_task_options(&bz.0).await.map_err(BzErr::msg)
}
