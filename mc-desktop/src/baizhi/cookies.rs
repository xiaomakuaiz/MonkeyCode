// 极简持久化 cookie 罐(agent/internal/baizhi/cookies.go 的 Rust 移植):
// RFC 6265 的域后缀 + 路径前缀匹配,JSON 落盘(0600,登录凭证)。
// 所有流量只对着 baizhi.cloud 一族域名,完整 jar 的公共后缀防护没有必要。
//
// 会话 cookie(无过期时间)也持久化——它就是登录凭证本身,桌面场景的
// 预期是"登录一次长期有效",真实有效期以服务端 401 为准。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
struct StoredCookie {
    name: String,
    value: String,
    /// 无前导点;host_only 区分匹配语义
    domain: String,
    /// 缺省 "/"
    path: String,
    /// RFC3339;None = 会话 cookie。与 Go 侧 time.Time JSON 格式互通。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    host_only: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    secure: bool,
}

fn parse_rfc3339(s: &str) -> Option<SystemTime> {
    // 只需要秒级精度判断过期:提取 unix 秒。格式 2026-07-19T12:34:56(.frac)?(Z|±hh:mm)
    // 用 httpdate 不行(格式不同);手写最小解析。
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    // 时区偏移
    let mut off = 0i64;
    if let Some(tzpos) = s.rfind(['+', '-']).filter(|&p| p >= 19) {
        let sign = if s.as_bytes()[tzpos] == b'+' { 1 } else { -1 };
        let tz = &s[tzpos + 1..];
        if tz.len() >= 5 {
            let th = tz[0..2].parse::<i64>().ok()?;
            let tm = tz[3..5].parse::<i64>().ok()?;
            off = sign * (th * 3600 + tm * 60);
        }
    }
    // 民用历 → unix 天数(Howard Hinnant 算法)
    let (y2, mo2) = if mo <= 2 { (y - 1, mo + 12) } else { (y, mo) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo2 - 3) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let unix = days * 86400 + h * 3600 + mi * 60 + sec - off;
    if unix < 0 {
        return None;
    }
    Some(UNIX_EPOCH + Duration::from_secs(unix as u64))
}

fn to_rfc3339(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    // unix 天数 → 民用历(同上算法逆向)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let (y, m) = if mp < 10 { (y, mp + 3) } else { (y + 1, mp - 9) };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60
    )
}

impl StoredCookie {
    fn expired(&self, now: SystemTime) -> bool {
        match &self.expires {
            Some(s) => parse_rfc3339(s).map(|t| now > t).unwrap_or(false),
            None => false,
        }
    }

    /// cookie 是否随发给 host+path 的请求携带。
    fn matches(&self, host: &str, path: &str) -> bool {
        if self.host_only {
            if host != self.domain {
                return false;
            }
        } else if host != self.domain && !host.ends_with(&format!(".{}", self.domain)) {
            return false;
        }
        let cp = if self.path.is_empty() { "/" } else { &self.path };
        path == cp || path.starts_with(&format!("{}/", cp.trim_end_matches('/')))
    }
}

/// 持久化 cookie 罐;path 为 None 时仅内存(测试)。
pub struct CookieStore {
    path: Option<PathBuf>,
    list: Mutex<Vec<StoredCookie>>,
}

impl CookieStore {
    /// 创建并尝试从磁盘恢复;文件不存在或损坏都从空开始(登录态可重建)。
    pub fn new(path: Option<PathBuf>) -> Self {
        let mut list = Vec::new();
        if let Some(p) = &path {
            if let Ok(data) = std::fs::read(p) {
                if let Ok(loaded) = serde_json::from_slice::<Vec<StoredCookie>>(&data) {
                    let now = SystemTime::now();
                    list = loaded.into_iter().filter(|c| !c.expired(now)).collect();
                }
            }
        }
        Self { path, list: Mutex::new(list) }
    }

    /// 吸收一条响应的 Set-Cookie 集合(覆盖同名同域同路径;过期/负 Max-Age 删除)。
    /// req_url 为发起请求的 URL(host-only 归属判定)。
    pub fn update(&self, req_url: &reqwest::Url, set_cookies: &[String]) {
        if set_cookies.is_empty() {
            return;
        }
        let now = SystemTime::now();
        let host = req_url.host_str().unwrap_or("").to_string();
        let mut list = self.list.lock().unwrap();
        for raw in set_cookies {
            let Ok(c) = cookie::Cookie::parse(raw.clone()) else { continue };
            let mut sc = StoredCookie {
                name: c.name().to_string(),
                value: c.value().to_string(),
                domain: c.domain().unwrap_or("").trim_start_matches('.').to_string(),
                path: c.path().unwrap_or("").to_string(),
                expires: None,
                host_only: false,
                secure: c.secure().unwrap_or(false),
            };
            // RFC 6265:无 Domain 属性,或属性与请求 host 不匹配,都按 host-only 处理
            if sc.domain.is_empty()
                || (host != sc.domain && !host.ends_with(&format!(".{}", sc.domain)))
            {
                sc.domain = host.clone();
                sc.host_only = true;
            }
            if sc.path.is_empty() {
                sc.path = "/".into();
            }
            match c.max_age() {
                Some(ma) if ma.whole_seconds() > 0 => {
                    sc.expires =
                        Some(to_rfc3339(now + Duration::from_secs(ma.whole_seconds() as u64)));
                }
                Some(_) => {
                    // 零/负 Max-Age = 立即过期(删除)
                    sc.expires = Some(to_rfc3339(now - Duration::from_secs(3600)));
                }
                None => {
                    if let Some(cookie::Expiration::DateTime(dt)) = c.expires() {
                        let unix = dt.unix_timestamp();
                        if unix > 0 {
                            sc.expires = Some(to_rfc3339(UNIX_EPOCH + Duration::from_secs(unix as u64)));
                        }
                    }
                }
            }
            if let Some(slot) = list
                .iter_mut()
                .find(|e| e.name == sc.name && e.domain == sc.domain && e.path == sc.path)
            {
                *slot = sc;
            } else {
                list.push(sc);
            }
        }
        list.retain(|c| !c.expired(now));
        self.save_locked(&list);
    }

    /// 拼请求应携带的 Cookie 头;无匹配返回 None。
    pub fn header(&self, url: &reqwest::Url) -> Option<String> {
        let now = SystemTime::now();
        let host = url.host_str().unwrap_or("");
        let path = if url.path().is_empty() { "/" } else { url.path() };
        let secure = url.scheme() == "https";
        let list = self.list.lock().unwrap();
        let parts: Vec<String> = list
            .iter()
            .filter(|c| !c.expired(now) && (!c.secure || secure) && c.matches(host, path))
            .map(|c| format!("{}={}", c.name, c.value))
            .collect();
        if parts.is_empty() {
            None
        } else {
            Some(parts.join("; "))
        }
    }

    /// 清空全部 cookie 并删除落盘文件(登出)。
    pub fn clear(&self) {
        let mut list = self.list.lock().unwrap();
        list.clear();
        if let Some(p) = &self.path {
            let _ = std::fs::remove_file(p);
        }
    }

    /// 是否没有任何(未过期)cookie。
    pub fn is_empty(&self) -> bool {
        let now = SystemTime::now();
        self.list.lock().unwrap().iter().all(|c| c.expired(now))
    }

    fn save_locked(&self, list: &[StoredCookie]) {
        let Some(p) = &self.path else { return };
        let Ok(data) = serde_json::to_vec_pretty(list) else { return };
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
            }
        }
        // 同目录临时文件 + rename,避免半写文件
        let tmp = p.with_extension(format!("tmp{}", std::process::id()));
        if std::fs::write(&tmp, &data).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
            let _ = std::fs::rename(&tmp, p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).unwrap()
    }

    #[test]
    fn set_and_match() {
        let store = CookieStore::new(None);
        store.update(&url("https://baizhi.cloud/api/v1/login"), &["sid=abc; Path=/; Domain=baizhi.cloud".into()]);
        // 域后缀匹配:子域也带
        assert_eq!(store.header(&url("https://baizhi.cloud/api/v1/user/profile")).unwrap(), "sid=abc");
        assert_eq!(store.header(&url("https://app.baizhi.cloud/x")).unwrap(), "sid=abc");
        assert!(store.header(&url("https://other.cloud/x")).is_none());
        assert!(!store.is_empty());
    }

    #[test]
    fn host_only_when_no_domain_attr() {
        let store = CookieStore::new(None);
        store.update(&url("https://baizhi.cloud/"), &["sid=abc; Path=/".into()]);
        assert!(store.header(&url("https://app.baizhi.cloud/")).is_none());
        assert_eq!(store.header(&url("https://baizhi.cloud/")).unwrap(), "sid=abc");
    }

    #[test]
    fn mismatched_domain_attr_becomes_host_only() {
        // 联调假服务在 localhost 却声明 .baizhi.cloud → host-only 处理
        let store = CookieStore::new(None);
        store.update(&url("http://localhost:8080/"), &["sid=abc; Domain=baizhi.cloud".into()]);
        assert!(store.header(&url("https://baizhi.cloud/")).is_none());
        assert_eq!(store.header(&url("http://localhost:8080/")).unwrap(), "sid=abc");
    }

    #[test]
    fn secure_requires_https() {
        let store = CookieStore::new(None);
        store.update(&url("https://baizhi.cloud/"), &["sid=abc; Secure".into()]);
        assert!(store.header(&url("http://baizhi.cloud/")).is_none());
        assert_eq!(store.header(&url("https://baizhi.cloud/")).unwrap(), "sid=abc");
    }

    #[test]
    fn negative_max_age_deletes() {
        let store = CookieStore::new(None);
        store.update(&url("https://baizhi.cloud/"), &["sid=abc".into()]);
        assert!(!store.is_empty());
        store.update(&url("https://baizhi.cloud/"), &["sid=; Max-Age=0".into()]);
        assert!(store.is_empty());
    }

    #[test]
    fn path_prefix_match() {
        let store = CookieStore::new(None);
        store.update(&url("https://x.cn/api/"), &["a=1; Path=/api".into()]);
        assert!(store.header(&url("https://x.cn/api/v1")).is_some());
        assert!(store.header(&url("https://x.cn/apix")).is_none());
    }

    #[test]
    fn rfc3339_roundtrip() {
        let t = UNIX_EPOCH + Duration::from_secs(1_789_000_000);
        let s = to_rfc3339(t);
        assert_eq!(parse_rfc3339(&s).unwrap(), t);
        // Go 侧格式(带偏移)也能读
        assert!(parse_rfc3339("2026-07-19T12:00:00+08:00").is_some());
        assert!(parse_rfc3339("2026-07-19T12:00:00.123456789Z").is_some());
    }
}
