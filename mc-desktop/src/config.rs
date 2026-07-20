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
    "mc-agent".into()
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
    /// agent 引擎:"mc-agent"(默认)| "ohmyagent"。保存即重启对应引擎。
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

/// 内核消费的配置文件路径集合。
pub struct KernelFiles {
    pub models: PathBuf,
    pub mcp: PathBuf,
}

/// 写应用配置 + 内核清单(模型 + MCP,均 0600,含密钥)。
pub fn save_config_files(app: &AppHandle, cfg: &DesktopConfig) -> Result<KernelFiles, String> {
    let dir = config_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;

    let write = |path: &PathBuf, data: Vec<u8>| -> Result<(), String> {
        fs::write(path, data).map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    };

    let cfg_data = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    write(&dir.join("config.json"), cfg_data)?;

    let files = KernelFiles {
        models: dir.join("models.json"),
        mcp: dir.join("mcp.json"),
    };
    let models_data = serde_json::to_vec_pretty(&cfg.models).map_err(|e| e.to_string())?;
    write(&files.models, models_data)?;

    let mcp_data = serde_json::to_vec_pretty(&serde_json::json!({ "mcpServers": cfg.mcp_servers }))
        .map_err(|e| e.to_string())?;
    write(&files.mcp, mcp_data)?;

    // ohmyagent 引擎:配置由壳接管写 ~/.ohmyagent(桌面版声明式管理)。
    // 仅在选中该引擎时写,避免无谓覆盖用户 CLI 配置。
    if cfg.agent_engine == "ohmyagent" {
        write_ohmyagent_config(cfg)?;
    }
    Ok(files)
}

/// 壳清单 → ~/.ohmyagent/settings.json + mcp.json。
///
/// 映射:HostModel{name,provider,base_url,api_key,model} →
///   settings.providers{<route>: {api_key, base_url}} + settings.models[{id,provider,context_window}]
/// 协议 → provider 路由:anthropic→anthropic、openai→openai-chat、
/// openai_responses→openai-responses。
///
/// 已知限制(引擎协议决定):每个 provider 路由只有一组 endpoint/key,
/// 同协议多网关时默认模型所在网关生效,其余条目跳过(stderr 告警);
/// mcp.json 无 headers 字段,需要鉴权头的条目(百智 MCP 网关)无法携带,跳过。
///
/// 首次接管前把用户已有文件备份为 .bak(仅当 .bak 不存在,保留最初原件)。
fn write_ohmyagent_config(cfg: &DesktopConfig) -> Result<(), String> {
    let home = home_dir().ok_or("无法定位用户主目录")?;
    let dir = home.join(".ohmyagent");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 ~/.ohmyagent 失败: {e}"))?;

    let backup = |name: &str| {
        let p = dir.join(name);
        let bak = dir.join(format!("{name}.bak"));
        if p.exists() && !bak.exists() {
            let _ = fs::copy(&p, &bak);
        }
    };
    backup("settings.json");
    backup("mcp.json");

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
                let has_headers = v
                    .get("headers")
                    .and_then(|h| h.as_object())
                    .map(|h| !h.is_empty())
                    .unwrap_or(false);
                if has_headers {
                    eprintln!(
                        "[mc-desktop] ohmyagent 引擎限制:MCP 条目「{name}」需要鉴权头,协议不支持,已跳过"
                    );
                    continue;
                }
                servers.push(serde_json::json!({ "name": name, "transport": "streamable-http", "url": url }));
            }
        }
    }
    write0600(
        &dir.join("mcp.json"),
        serde_json::to_vec_pretty(&serde_json::json!({ "servers": servers })).map_err(|e| e.to_string())?,
    )?;
    Ok(())
}
