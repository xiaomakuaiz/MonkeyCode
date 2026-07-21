// 应用配置(壳持有)与内核清单文件写出。
//
// 壳只认顶层业务 key(models/mcp_servers/kernel_env/agent_engine),内容
// **原样透传**不做业务校验——schema 的唯一来源是内核(config.LoadModels)与
// 设置视图表单(agent/ui),壳零字段知识;非法内容由内核以零模型模式容忍并
// 经 UI 引导修复。pet_* 是壳自有偏好:设置视图不感知,save_config 时从磁盘
// 合并保留(否则每次保存设置都会被 serde 默认值冲掉)。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

fn json_array() -> serde_json::Value {
    serde_json::Value::Array(vec![])
}
fn json_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

fn default_true() -> bool {
    true
}

fn default_engine() -> String {
    String::new() // 字段已废弃,仅兼容旧 config.json 反序列化
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DesktopConfig {
    #[serde(default = "json_array")]
    pub models: serde_json::Value,
    /// MCP 服务器(name → 配置,与内核 mcp.json 的 mcpServers 同构)
    #[serde(default = "json_object")]
    pub mcp_servers: serde_json::Value,
    /// 内核运行环境:空 = 本机;"wsl:<发行版>" = 在 WSL 中运行(仅 Windows)。
    #[serde(default)]
    pub kernel_env: String,
    /// 已废弃(单引擎化后忽略):历史 config.json 兼容保留,不再消费。
    #[serde(default = "default_engine")]
    pub agent_engine: String,
    /// 桌宠开关(托盘菜单切换)
    #[serde(default = "default_true")]
    pub pet_enabled: bool,
    /// 桌宠窗口位置(物理像素;拖动后记忆)
    #[serde(default)]
    pub pet_pos: Option<(i32, i32)>,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            models: json_array(),
            mcp_servers: json_object(),
            kernel_env: String::new(),
            agent_engine: default_engine(),
            pet_enabled: true,
            pet_pos: None,
        }
    }
}

pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))
}

/// 用户主目录:HOME(unix)→ USERPROFILE(Windows,HOME 通常未设)。
/// Go 侧 os.UserHomeDir 的等价物;所有 ~ 展开与 ~/.xxx 定位统一走这里。
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// unix 毫秒 → RFC3339(UTC)。会话 updated_at 等对 UI 的时间字段统一此
/// 格式(与 Go 侧 time.Time 的 JSON 序列化对表,字典序即时间序)。
pub fn ms_to_rfc3339(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    // unix 天数 → 民用历(Howard Hinnant 算法)
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

/// 展开路径开头的 ~/(或裸 ~)为用户主目录;非 ~ 开头原样返回。
pub fn expand_tilde(path: &str) -> String {
    if path == "~" {
        return home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

pub fn load_config(app: &AppHandle) -> DesktopConfig {
    let Ok(dir) = config_dir(app) else {
        return DesktopConfig::default();
    };
    fs::read(dir.join("config.json"))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

/// 只写权威 config.json(壳自有偏好如桌宠走这条,不触发引擎配置物化)。
pub fn save_config_json(app: &AppHandle, cfg: &DesktopConfig) -> Result<(), String> {
    let dir = config_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let data = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    let path = dir.join("config.json");
    fs::write(&path, data).map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 写应用配置(权威 config.json)+ 物化引擎配置(engine_config_dir,0600 含密钥)。
/// 引擎(重)启路径专用;桌宠偏好等壳自有字段用 save_config_json。
pub fn save_config_files(app: &AppHandle, cfg: &DesktopConfig) -> Result<(), String> {
    save_config_json(app, cfg)?;
    write_ohmyagent_config(&engine_config_dir(app)?, cfg)
}

/// 引擎配置目录:app_config_dir/ohmyagent(经 OHMYAGENT_CONFIG_DIR 注入引擎)。
/// 桌面版自此拥有私有引擎目录,不再接管用户全局 ~/.ohmyagent(CLI 不受影响)。
pub fn engine_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("ohmyagent"))
}

/// 壳清单 → <engine_config_dir>/settings.json + mcp.json。
///
/// 映射:HostModel{name,provider,base_url,api_key,model} →
///   settings.providers{<route>: {api_key, base_url}} + settings.models[{id,provider,context_window}]
/// 协议 → provider 路由:anthropic→anthropic、openai→openai-chat、
/// openai_responses→openai-responses。
///
/// 已知限制(引擎协议决定):每个 provider 路由只有一组 endpoint/key,
/// 同协议多网关时默认模型所在网关生效,其余条目跳过(stderr 告警)。
fn write_ohmyagent_config(dir: &PathBuf, cfg: &DesktopConfig) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建引擎配置目录失败: {e}"))?;

    let route_of = |provider: &str| match provider {
        "openai" => "openai-chat",
        "openai_responses" => "openai-responses",
        _ => "anthropic",
    };
    // providers 表的键是 ohmyagent 的 configKey(provider.go providerRoutes),
    // 与模型条目的路由 id 不同:openai-chat/openai-responses 都查 "openai"。
    fn config_key_of(route: &str) -> &str {
        match route {
            "openai-chat" | "openai-responses" => "openai",
            other => other,
        }
    }

    // 默认模型优先占路由:先按 default 排序再逐个落 provider 槽位
    let empty = vec![];
    let models_arr = cfg.models.as_array().unwrap_or(&empty);
    let mut ordered: Vec<&serde_json::Value> = models_arr.iter().collect();
    ordered.sort_by_key(|m| !m.get("default").and_then(|v| v.as_bool()).unwrap_or(false));

    let mut providers = serde_json::Map::new();
    let mut models_out: Vec<serde_json::Value> = Vec::new();
    let mut default_model = String::new();
    let mut seen_ids: std::collections::HashSet<String> = Default::default();
    for m in ordered {
        let get = |k: &str| m.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let (name, provider, base_url, api_key, model) =
            (get("name"), get("provider"), get("base_url"), get("api_key"), get("model"));
        if name.is_empty() || model.is_empty() {
            continue;
        }
        let route = route_of(&provider);
        let config_key = config_key_of(route);
        match providers.get(config_key) {
            None => {
                providers.insert(
                    config_key.to_string(),
                    serde_json::json!({ "api_key": api_key, "base_url": base_url }),
                );
            }
            Some(existing) => {
                let same = existing.get("api_key").and_then(|v| v.as_str()) == Some(api_key.as_str())
                    && existing.get("base_url").and_then(|v| v.as_str()) == Some(base_url.as_str());
                if !same {
                    eprintln!(
                        "[mc-desktop] ohmyagent 引擎限制:{config_key} 凭据槽已被占用,模型「{name}」的网关配置被跳过"
                    );
                    continue;
                }
            }
        }
        if seen_ids.insert(model.clone()) {
            let mut entry = serde_json::json!({ "id": model, "provider": route });
            if let Some(cw) = m.get("context_window").and_then(|v| v.as_i64()).filter(|&c| c > 0) {
                entry["context_window"] = serde_json::json!(cw);
            }
            // 视觉标记透传:缺失时 ohmyagent 按不支持处理,读图降级为文本占位
            if m.get("vision").and_then(|v| v.as_bool()).unwrap_or(false) {
                entry["supports_images"] = serde_json::json!(true);
            }
            models_out.push(entry);
        }
        let is_default = m.get("default").and_then(|v| v.as_bool()).unwrap_or(false);
        if default_model.is_empty() || is_default {
            default_model = model.clone();
        }
    }

    let settings = serde_json::json!({
        "default_model": default_model,
        "permission_mode": "default",
        "providers": providers,
        "models": models_out,
    });
    let write0600 = |path: &PathBuf, data: Vec<u8>| -> Result<(), String> {
        fs::write(path, data).map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    };
    write0600(&dir.join("settings.json"), serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?)?;

    // MCP:壳词汇 {name: {command,args,env}|{url,headers}} → ohmy {servers:[{name,transport,…}]}
    let mut servers: Vec<serde_json::Value> = Vec::new();
    if let Some(map) = cfg.mcp_servers.as_object() {
        for (name, v) in map {
            // 设置页「停用」的 server 不物化:mcp.json 是引擎 MCP 的唯一
            // 来源,此处过滤即全链路生效(保存配置随即重启引擎重读)
            if v.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false) {
                continue;
            }
            if let Some(cmd) = v.get("command").and_then(|c| c.as_str()) {
                let mut entry = serde_json::json!({ "name": name, "transport": "stdio", "command": cmd });
                if let Some(args) = v.get("args") {
                    entry["args"] = args.clone();
                }
                if let Some(env) = v.get("env") {
                    entry["env"] = env.clone();
                }
                servers.push(entry);
            } else if let Some(url) = v.get("url").and_then(|u| u.as_str()) {
                let mut entry =
                    serde_json::json!({ "name": name, "transport": "streamable-http", "url": url });
                if let Some(h) = v.get("headers").and_then(|h| h.as_object()).filter(|h| !h.is_empty()) {
                    entry["headers"] = serde_json::json!(h);
                }
                servers.push(entry);
            }
        }
    }
    // 内置条目:壳的浏览器桥 MCP(browser_* 工具)。Bearer token 进程级
    // 每次启动新发;mcp.json 随引擎(重)启重写,恒为当前值,无需持久。
    if let Some((url, token)) = crate::browser::mcp_endpoint() {
        servers.push(serde_json::json!({
            "name": "mc-browser", "transport": "streamable-http", "url": url,
            "headers": { "Authorization": format!("Bearer {token}") },
        }));
    }
    write0600(
        &dir.join("mcp.json"),
        serde_json::to_vec_pretty(&serde_json::json!({ "servers": servers })).map_err(|e| e.to_string())?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 设置页停用的 MCP 不得物化进引擎 mcp.json(mcp.json 是引擎 MCP
    /// 的唯一来源,漏过滤 = 禁用不生效)。
    #[test]
    fn disabled_mcp_excluded_from_mcp_json() {
        let dir = std::env::temp_dir().join(format!("mc-mcp-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let cfg = DesktopConfig {
            mcp_servers: serde_json::json!({
                "on-stdio": { "command": "npx", "args": ["-y", "some-mcp"] },
                "off-stdio": { "command": "npx", "disabled": true },
                "off-http": { "url": "https://example.invalid/mcp", "disabled": true },
            }),
            ..Default::default()
        };
        write_ohmyagent_config(&dir, &cfg).unwrap();
        let mcp: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("mcp.json")).unwrap()).unwrap();
        let names: Vec<&str> = mcp["servers"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["name"].as_str())
            .collect();
        assert!(names.contains(&"on-stdio"), "未禁用的 server 应保留: {names:?}");
        assert!(!names.contains(&"off-stdio"), "禁用的 stdio server 应被过滤: {names:?}");
        assert!(!names.contains(&"off-http"), "禁用的 http server 应被过滤: {names:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}
