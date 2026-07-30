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

use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::State;

use cookies::CookieStore;

const DEFAULT_MODEL_GATEWAY: &str = "https://ai-models.app.baizhi.cloud";
const DEFAULT_MCP_GATEWAY: &str = "https://agent-toolkit.app.baizhi.cloud";

/// 百智云服务地址。模型与 MCP 服务固定走官方云;账号和 MonkeyCode 地址可覆盖。
pub struct Endpoints {
    /// 账号/登录域(验证码、手机号/微信登录、profile)
    pub account: String,
    /// 模型服务:/api/console/* 取 key 与模型列表;/api/openai、/api/anthropic 推理
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
    /// mc_base_url 来自设置(config.json,自建/私有化部署地址;空 = 官方云)。
    /// 优先级:环境变量(开发/联调逃生门)> 设置值 > 官方云默认。
    pub fn resolve(mc_base_url: &str) -> Self {
        let mc_default = mc_base_url.trim();
        let mc_default = if mc_default.is_empty() { "https://monkeycode-ai.com" } else { mc_default };
        Self {
            account: env_or("MC_DESKTOP_BAIZHI_URL", "https://baizhi.cloud"),
            model_gateway: DEFAULT_MODEL_GATEWAY.to_string(),
            mcp_gateway: DEFAULT_MCP_GATEWAY.to_string(),
            monkeycode: env_or("MC_DESKTOP_MONKEYCODE_URL", mc_default),
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
    ///
    /// Option 而非直接 Client:构建只在 TLS 后端起不来时失败,此前是
    /// `.expect()`——而 Service::new 在 setup 里跑,GUI 子系统下(Windows
    /// 无控制台)panic 就是双击没反应、零线索。云端/账号是可降级功能面,
    /// 本地引擎会话并不依赖它,不该被它拖着一起打不开。
    http: Option<reqwest::Client>,
    /// 微信授权页/二维码/长轮询(长轮询最长挂 ~25s)
    lp: Option<reqwest::Client>,
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
            http: Some(mk(10)),
            lp: Some(mk(10)),
            store: CookieStore::new(None),
            mc: CookieStore::new(None),
            wx: StdMutex::new(None),
        }
    }

    pub fn new(config_dir: std::path::PathBuf, mc_base_url: &str) -> Self {
        // 构建失败只发生在 TLS 后端初始化不了时。不 panic:壳在 setup 里
        // 构造本服务,GUI 子系统下 panic = 双击没反应、无任何线索。降级为
        // 云端/账号命令逐条报错,本地引擎会话不受影响。
        let mk = |timeout: u64| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(timeout))
                .build()
                .inspect_err(|e| eprintln!("[desktop] HTTP 客户端构建失败(云端/账号功能不可用): {e}"))
                .ok()
        };
        Self {
            ep: Endpoints::resolve(mc_base_url),
            http: mk(30),
            lp: mk(40),
            store: CookieStore::new(Some(config_dir.join("baizhi-cookies.json"))),
            mc: CookieStore::new(Some(config_dir.join("monkeycode-cookies.json"))),
            wx: StdMutex::new(None),
        }
    }

    /// 取 API 客户端;TLS 后端起不来时给出可行动错误而不是 panic。
    fn http(&self) -> BzResult<&reqwest::Client> {
        self.http
            .as_ref()
            .ok_or_else(|| other("HTTP 客户端初始化失败(系统 TLS 不可用),云端与账号功能暂不可用"))
    }

    /// 取长轮询客户端(同上)。
    fn lp(&self) -> BzResult<&reqwest::Client> {
        self.lp
            .as_ref()
            .ok_or_else(|| other("HTTP 客户端初始化失败(系统 TLS 不可用),云端与账号功能暂不可用"))
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
        let mut req = self.http()?.request(method, url.clone());
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
        let mut req = self.lp()?.get(url.clone());
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
        unwrap_envelope(&data, status, &ENV_BAIZHI)
    }

    /// 请求裸结构端点(验证码 challenge/redeem 不套包壳;2xx 即成功)。
    pub async fn call_raw(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> BzResult<Value> {
        let target = if path.starts_with("http://") || path.starts_with("https://") {
            path.to_string()
        } else {
            format!("{}{}", self.ep.account, path)
        };
        self.raw_at(&self.store, method, &target, body, "百智云").await
    }

    /// call_raw 的自由地址版:罐与错误标签由调用方指定。罐参数决定的是
    /// 响应 Set-Cookie 的**吸收方向**(裸结构端点本身多为免鉴权)——
    /// MonkeyCode 域必须传 mc 罐,用百智罐会把 mc 域 cookie 混进百智罐,
    /// 破坏双罐隔离。
    async fn raw_at(
        &self,
        store: &CookieStore,
        method: reqwest::Method,
        target: &str,
        body: Option<&Value>,
        label: &str,
    ) -> BzResult<Value> {
        let (data, status) = self.do_store(store, method, target, body).await?;
        if !(200..300).contains(&status) {
            if let Ok(v) = serde_json::from_slice::<Value>(&data) {
                if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
                    return Err(other(clean_message(m)));
                }
            }
            return Err(http_error(status, &data, label));
        }
        serde_json::from_slice(&data).map_err(|e| other(format!("{label}响应解析失败: {e}")))
    }

    // ==================== 登录/状态 ====================

    /// 百智云域的 PoW 验证码(手机号发码/登录用)。
    async fn obtain_captcha_token(&self) -> BzResult<String> {
        self.captcha_token_at(&self.ep.account, &self.store, "百智云").await
    }

    /// 完整跑一遍 PoW 验证码,返回登录接口所需 captcha_token。百智云与
    /// MonkeyCode 服务端用同一套 go-cap 协议(challenge 201 裸结构 → 本地
    /// 爆破 → redeem 换 token),差异只在域、cookie 罐与错误标签。
    pub(crate) async fn captcha_token_at(&self, base: &str, store: &CookieStore, label: &str) -> BzResult<String> {
        let ch = self
            .raw_at(
                store,
                reqwest::Method::POST,
                &format!("{base}/api/v1/public/captcha/challenge"),
                None,
                label,
            )
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
            .raw_at(
                store,
                reqwest::Method::POST,
                &format!("{base}/api/v1/public/captcha/redeem"),
                Some(&json!({ "token": token, "solutions": solutions })),
                label,
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

/// 包壳解包策略。四个后端(百智云账号域/模型网关/MCP 网关/MonkeyCode)的
/// {code,message,(success),data} 包壳结构相同,差异只在 code 合法值集合、
/// 3xx/401 处理与 data 缺失兜底——用参数钉住差异,防止各自拷贝后语义漂移。
pub(crate) struct Envelope {
    /// http_error 的前缀标签(拉丁词标签自带尾部空格,与中文拼接时留排版间隔)
    pub label: &'static str,
    /// code 字段合法值判定(收到的是 `v.get("code")` 原值,含缺失/非数字情形)
    pub code_ok: fn(Option<&Value>) -> bool,
    /// 是否额外检查 success 布尔字段(百智云账号域包壳带 success)
    pub check_success: bool,
    /// Some(文案):3xx 直接以该文案判失败(MCP 网关未开通时不重定向即 302)
    pub redirect_msg: Option<&'static str>,
    /// Some(文案):401 不看响应体,直接返回固定 Unauthorized
    /// (MonkeyCode 链路的 401 恢复动作是"到设置中重新连接"——桥接或账密皆可)
    pub fixed_401: Option<&'static str>,
    /// data 缺失/为 null 时:true 返回整个响应体(百智云,对齐移动端),false 返回 Null
    pub whole_body_fallback: bool,
}

/// 常规 code 判定:整数 0 合法;缺失或非数字不视为失败(与各链路原语义一致)。
pub(crate) fn code_is_zero(c: Option<&Value>) -> bool {
    c.and_then(Value::as_i64).map(|x| x == 0).unwrap_or(true)
}

/// 百智云账号域:包壳带 success 布尔;缺 data 回整个响应体(对齐移动端)。
pub(crate) const ENV_BAIZHI: Envelope = Envelope {
    label: "百智云",
    code_ok: code_is_zero,
    check_success: true,
    redirect_msg: None,
    fixed_401: None,
    whole_body_fallback: true,
};

/// 按策略解开包壳:非 2xx 或 code/success 判失败;失败信息经 clean_message,
/// 401 转 Unauthorized 哨兵;成功取 data。
pub(crate) fn unwrap_envelope(data: &[u8], status: u16, p: &Envelope) -> BzResult<Value> {
    if let Some(msg) = p.fixed_401 {
        if status == 401 {
            return Err(BzErr::Unauthorized(msg.into()));
        }
    }
    if let Some(msg) = p.redirect_msg {
        if (300..400).contains(&status) {
            return Err(other(msg));
        }
    }
    let is2xx = (200..300).contains(&status);
    let Ok(v) = serde_json::from_slice::<Value>(data) else {
        if is2xx {
            return Ok(Value::Null); // 非 JSON 但 2xx,视为成功无数据
        }
        return Err(http_error(status, data, p.label));
    };
    let code_fail = !(p.code_ok)(v.get("code"));
    let success_fail = p.check_success
        && v.get("success").and_then(|s| s.as_bool()).map(|s| !s).unwrap_or(false);
    if !is2xx || code_fail || success_fail {
        let msg = clean_message(v.get("message").and_then(|m| m.as_str()).unwrap_or(""));
        if msg.is_empty() {
            return Err(http_error(status, &[], p.label));
        }
        if status == 401 {
            return Err(BzErr::Unauthorized(msg));
        }
        return Err(other(msg));
    }
    match v.get("data") {
        Some(d) if !d.is_null() => Ok(d.clone()),
        _ if p.whole_body_fallback => Ok(v),
        _ => Ok(Value::Null),
    }
}

/// trace_id 剥离正则。OnceLock:clean_message 在每条错误路径上被调,
/// 现编译正则(微秒级但反复发生)纯属浪费,进程内编译一次即可。
static TRACE_ID_RE: OnceLock<regex::Regex> = OnceLock::new();

/// 去掉服务端 message 尾部的 trace_id 标注(对齐移动端)。
pub fn clean_message(msg: &str) -> String {
    TRACE_ID_RE
        .get_or_init(|| regex::Regex::new(r"(?i)\s*\[trace_id:[^\]]+\]\s*$").unwrap())
        .replace(msg, "")
        .trim()
        .to_string()
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

/// MonkeyCode 账号密码直连登录(不经百智云;壳内自动完成 PoW 验证码)。
/// 校验对齐 mobile 的弱校验:仅非空;password **不 trim**——首尾空格是
/// 密码的一部分,trim 会与 mobile/web 行为分叉。
#[tauri::command]
pub async fn mc_password_login(bz: State<'_, BaizhiState>, email: String, password: String) -> Result<Value, String> {
    let email = email.trim();
    if email.is_empty() || password.is_empty() {
        return Err("请输入邮箱和密码".into());
    }
    let user = monkeycode::login_monkeycode_password(&bz.0, email, &password)
        .await
        .map_err(BzErr::msg)?;
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

// ==================== OhMyAgent 代理密钥(会员模型本地同步用) ====================

/// 代理密钥文件。服务端契约(POST /api/v1/users/ohmyagent/api-keys):Key 是
/// 模型无关的,LLM 请求的 model 字段传模型配置 ID;api_key 与 signing_secret
/// 明文**仅创建响应返回**,故必须本机持久化(0600,独立小文件——config.json
/// 是"损坏必须外显"的严格策略且表单外字段要在 merge_shell_prefs 逐个捞回,
/// 凭证缓存不该走那条路)。消费方是引擎物化(config.rs):api_key/base_url
/// 注入会员条目、signing_secret 注入顶层(引擎以它 HMAC 签署固定 system
/// prompt,服务端代理缺签名即拒)。
/// 复用/删除语义:同步复用已落盘的 Key(没有才创建),断开时按 id 删——
/// 服务端没有 Key 列表接口,id 只有本机知道,丢文件即孤儿 Key。
pub(crate) const OHMYAGENT_KEY_FILE: &str = "monkeycode-ohmyagent-key.json";

/// 已落盘的代理 Key(要求 id 与 api_key 齐全,损坏视为无)。物化路径
/// (config.rs)也读它:会员条目的 base_url/api_key 不进 UI/config.json,
/// 写引擎 settings.json 时才从这里注入。
pub(crate) fn stored_ohmyagent_key(cfg_dir: &std::path::Path) -> Option<Value> {
    let data = std::fs::read(cfg_dir.join(OHMYAGENT_KEY_FILE)).ok()?;
    let v: Value = serde_json::from_slice(&data).ok()?;
    let has = |k: &str| v.get(k).and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false);
    (has("id") && has("api_key")).then_some(v)
}

/// 取本机代理 Key,没有就创建并立刻落盘(明文只此一次,不落盘即丢)。
/// 落盘时附上代理 base_url 快照(服务端同源 /v1)——物化注入的另一半;
/// 旧文件缺 base_url 时(历史迭代产物)同步顺手回填,不留哑条目。
/// 快照与当前地址不一致 = 用户切换了服务地址:旧 Key 属旧服务器,复用
/// 即跨服误用,作废重建(旧服务器侧的 Key 无从删除——会话已在新地址,
/// 记录为已知限制)。
async fn ensure_ohmyagent_key(svc: &Service, cfg_dir: &std::path::Path) -> BzResult<Value> {
    let base_url = format!("{}/v1", svc.ep.monkeycode);
    let persist = |k: &Value| {
        crate::config::atomic_write_private(&cfg_dir.join(OHMYAGENT_KEY_FILE), k.to_string().as_bytes())
            .map_err(other)
    };
    if let Some(mut k) = stored_ohmyagent_key(cfg_dir) {
        match k.get("base_url").and_then(Value::as_str).unwrap_or("") {
            b if b == base_url => return Ok(k),
            "" => {
                k["base_url"] = json!(base_url);
                persist(&k)?;
                return Ok(k);
            }
            _ => {} // 地址已切换,落到下方重建
        }
    }
    let mut k = monkeycode::mc_ohmyagent_key_create(svc).await?;
    k["base_url"] = json!(base_url);
    persist(&k)?;
    Ok(k)
}

/// 同步会员内置模型(命令的可测内核:tests.rs 以 TempDir 直调)。
pub(crate) async fn sync_member_models(svc: &Service, cfg_dir: &std::path::Path) -> BzResult<Value> {
    ensure_ohmyagent_key(svc, cfg_dir).await?; // 条目不带凭据,但 Key 必须此刻落盘
    monkeycode::mc_member_models_sync(svc).await
}

/// 删除本机代理 Key:删成功才移除本地记录;删失败(如断网)保留记录——
/// 下次同步继续复用同一把 Key、下次断开重试删除,网络恢复后自然收敛,
/// 也不会在服务端积累孤儿 Key。
pub(crate) async fn revoke_member_models(svc: &Service, cfg_dir: &std::path::Path) -> BzResult<()> {
    let Some(key) = stored_ohmyagent_key(cfg_dir) else {
        return Ok(()); // 从未同步过,无可删
    };
    let id = key.get("id").and_then(Value::as_str).unwrap_or("");
    monkeycode::mc_ohmyagent_key_delete(svc, id).await?;
    let _ = std::fs::remove_file(cfg_dir.join(OHMYAGENT_KEY_FILE));
    Ok(())
}

/// 同步 MonkeyCode 会员内置模型为本地条目(source="monkeycode";复用/创建
/// 本机代理 Key,base_url 指向服务端模型代理)。与 baizhi_sync 同款语义:
/// 不碰 config.json,纯返回 {models, notes},由 UI 交用户确认后保存。
#[tauri::command]
pub async fn mc_models_sync(app: tauri::AppHandle, bz: State<'_, BaizhiState>) -> Result<Value, String> {
    let cfg_dir = crate::config::config_dir(&app)?;
    sync_member_models(&bz.0, &cfg_dir).await.map_err(BzErr::msg)
}

/// 删除本机的会员模型代理 Key(断开 MonkeyCode 账号时调用;从未同步过
/// 直接成功)。须在清除 mc 会话之前调用——删除走 mc 会话认证。
#[tauri::command]
pub async fn mc_models_revoke(app: tauri::AppHandle, bz: State<'_, BaizhiState>) -> Result<Value, String> {
    let cfg_dir = crate::config::config_dir(&app)?;
    revoke_member_models(&bz.0, &cfg_dir).await.map_err(BzErr::msg)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn mc_tasks(
    bz: State<'_, BaizhiState>,
    page: u32,
    size: u32,
    status: Option<String>,
    project_id: Option<String>,
    quick_start: Option<bool>,
) -> Result<Value, String> {
    let size = size.clamp(1, 50);
    let page = page.max(1);
    monkeycode::mc_tasks(
        &bz.0,
        page,
        size,
        status.as_deref().unwrap_or(""),
        project_id.as_deref().unwrap_or(""),
        quick_start,
    )
    .await
    .map_err(BzErr::msg)
}

#[tauri::command]
pub async fn mc_projects(bz: State<'_, BaizhiState>) -> Result<Value, String> {
    monkeycode::mc_projects(&bz.0).await.map_err(BzErr::msg)
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
pub async fn mc_task_delete(bz: State<'_, BaizhiState>, id: String) -> Result<Value, String> {
    monkeycode::mc_task_delete(&bz.0, &id).await.map_err(BzErr::msg)?;
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

/// 云端聊天附件上传(data = base64 文件字节);返回 {access_url}。
#[tauri::command]
pub async fn mc_upload(bz: State<'_, BaizhiState>, filename: String, data: String) -> Result<Value, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("附件数据解码失败: {e}"))?;
    let access_url = monkeycode::mc_upload(&bz.0, &filename, bytes).await.map_err(BzErr::msg)?;
    Ok(json!({ "access_url": access_url }))
}

/// 虚拟机终端 session 列表(终端面板复用已有会话用;返回 {terminals})。
#[tauri::command]
pub async fn mc_terminal_list(bz: State<'_, BaizhiState>, vm_id: String) -> Result<Value, String> {
    monkeycode::mc_terminal_list(&bz.0, &vm_id).await.map_err(BzErr::msg)
}

/// 从云端任务 VM 工作区下载文件/目录到本地(dest 为 UI 经保存对话框
/// 选定的本地路径;目录由服务端打成 zip)。dl_id 由 UI 生成,进度经
/// `dl-progress:{dl_id}` 事件上报,取消走 mc_file_download_cancel。
/// 返回 {ok, bytes}。
#[tauri::command]
pub async fn mc_file_download(
    app: tauri::AppHandle,
    bz: State<'_, BaizhiState>,
    ctl: State<'_, monkeycode::DownloadCtl>,
    dl_id: String,
    vm_id: String,
    path: String,
    filename: String,
    dest: String,
) -> Result<Value, String> {
    let bytes = monkeycode::mc_file_download(&app, &ctl, &bz.0, &dl_id, &vm_id, &path, &filename, &dest)
        .await
        .map_err(BzErr::msg)?;
    Ok(json!({ "ok": true, "bytes": bytes }))
}

/// 取消进行中的下载(置旗,由下载循环在块间收束并清残件;已完成/不存在
/// 静默——取消与完成天然赛跑)。
#[tauri::command]
pub async fn mc_file_download_cancel(
    ctl: State<'_, monkeycode::DownloadCtl>,
    dl_id: String,
) -> Result<Value, String> {
    ctl.cancel(&dl_id);
    Ok(json!({ "ok": true }))
}

/// 上传文件到云端任务 VM 工作区(path 为 VM 内绝对路径,data = base64 文件字节)。
#[tauri::command]
pub async fn mc_file_upload(
    bz: State<'_, BaizhiState>,
    vm_id: String,
    path: String,
    data: String,
) -> Result<Value, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("文件数据解码失败: {e}"))?;
    monkeycode::mc_file_upload(&bz.0, &vm_id, &path, bytes).await.map_err(BzErr::msg)?;
    Ok(json!({ "ok": true }))
}
