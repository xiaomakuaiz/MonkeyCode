// 模型网关/MCP 网关同步(agent/internal/baizhi/sync.go 的 Rust 移植)。
// 登录后从模型网关拉模型清单并确保有一把可用的推理密钥,产出可直接落盘的
// 清单(models.json 条目 + mcp.json servers)。UI 拿到后交用户确认再保存重启。
//
// 密钥策略:列表只给掩码,明文只在创建时返回一次 → 优先用调用方已持有的密钥
// (掩码前后缀匹配 + 必要时 PATCH 重新启用),都对不上才新建一把并启用。

use serde_json::{json, Value};

use super::{code_is_zero, other, unwrap_envelope, BzResult, Envelope, Service};

/// 同步新建密钥的名字(网关控制台里用户可见)。
const SYNC_KEY_NAME: &str = "MonkeyCode";
/// 同步条目的 source 标记(UI 按它分组/整组替换;对应 agent/ui/src/types.ts 的 SOURCE_BAIZHI)。
const SOURCE_BAIZHI: &str = "baizhi";
/// 同步产出的 mcp.json 条目名(工具命名空间前缀 mcp__<name>__)。
const MCP_ENTRY_NAME: &str = "baizhi-toolkit";

/// 拉模型清单 + 确保推理密钥。要求已登录(有 cookie)。
/// known_keys 是调用方已持有的候选明文密钥,能对上网关掩码就复用。
pub async fn sync(svc: &Service, known_keys: &[String]) -> BzResult<Value> {
    let (key, key_name, created) = ensure_api_key(svc, known_keys).await?;
    let (models, mut notes) = gateway_models(svc, &key).await?;
    let (mcp, mcp_notes) = mcp_servers(svc).await;
    notes.extend(mcp_notes);
    Ok(json!({
        "models": models,
        "mcp_servers": mcp,
        "key_created": created,
        "key_name": key_name,
        "notes": notes,
    }))
}

/// 模型网关包壳:标准 code=0 判定,无 success 字段。
pub(crate) const ENV_CONSOLE: Envelope = Envelope {
    label: "网关",
    code_ok: code_is_zero,
    check_success: false,
    redirect_msg: None,
    fixed_401: None,
    whole_body_fallback: false,
};

/// 模型网关请求(带 cookie),解包 {code,data,message}。
async fn console_call(svc: &Service, method: reqwest::Method, path: &str, body: Option<&Value>) -> BzResult<Value> {
    let target = format!("{}{}", svc.ep.model_gateway, path);
    let (data, status) = svc.do_store(&svc.store, method, &target, body).await?;
    unwrap_envelope(&data, status, &ENV_CONSOLE)
}

/// 确保拿到一把可用(存在且启用)的明文推理密钥。返回 (key, 密钥名, 是否新建)。
async fn ensure_api_key(svc: &Service, known_keys: &[String]) -> BzResult<(String, String, bool)> {
    let list = console_call(svc, reqwest::Method::GET, "/api/console/api-keys?page=1&pageSize=200", None)
        .await
        .map_err(|e| other(format!("获取密钥列表失败: {}", e.msg())))?;
    let items: Vec<Value> = list.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    // 已持有的明文密钥能对上网关掩码 → 复用(停用的先重新启用)
    for k in known_keys {
        let k = k.trim();
        if !k.starts_with("sk-") {
            continue;
        }
        for it in &items {
            let masked = it.get("maskedKey").and_then(|v| v.as_str()).unwrap_or("");
            if !masked_match(masked, k) {
                continue;
            }
            let name = it.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let enabled = it.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            if !enabled {
                enable_api_key(svc, it)
                    .await
                    .map_err(|e| other(format!("重新启用密钥「{name}」失败: {}", e.msg())))?;
            }
            return Ok((k.to_string(), name, false));
        }
    }

    // 新建 + 启用(新建的密钥默认停用)。密钥名全局唯一;同名旧 key 的明文
    // 已不可恢复,只能换名新建(不能动旧 key——它可能正被别的设备使用)。
    let name = pick_key_name(&items)?;
    let created = console_call(
        svc,
        reqwest::Method::POST,
        "/api/console/api-keys",
        Some(&json!({ "name": name })),
    )
    .await
    .map_err(|e| other(format!("创建密钥失败: {}", e.msg())))?;
    let key = created.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if key.is_empty() {
        return Err(other("创建密钥成功但响应未含明文密钥"));
    }
    enable_api_key(svc, &created)
        .await
        .map_err(|e| other(format!("启用新建密钥失败: {}", e.msg())))?;
    Ok((key, name, true))
}

/// 选一个与现有密钥不撞名的名字:MonkeyCode、MonkeyCode-2、…
fn pick_key_name(existing: &[Value]) -> BzResult<String> {
    let taken: std::collections::HashSet<&str> = existing
        .iter()
        .filter_map(|it| it.get("name").and_then(|v| v.as_str()))
        .collect();
    if !taken.contains(SYNC_KEY_NAME) {
        return Ok(SYNC_KEY_NAME.to_string());
    }
    for i in 2..=99 {
        let name = format!("{SYNC_KEY_NAME}-{i}");
        if !taken.contains(name.as_str()) {
            return Ok(name);
        }
    }
    Err(other(format!("网关中 {SYNC_KEY_NAME} 系列密钥过多,请在百智云控制台清理后重试")))
}

/// 启用密钥。PATCH 要求 name 必填(真机 400 实测)。
async fn enable_api_key(svc: &Service, item: &Value) -> BzResult<()> {
    let id = item.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
    console_call(
        svc,
        reqwest::Method::PATCH,
        &format!("/api/console/api-keys/{id}"),
        Some(&json!({ "name": name, "enabled": true })),
    )
    .await
    .map(|_| ())
}

/// 明文密钥与网关掩码是否指同一把 key(掩码形如 sk-7c263***…***27e2)。
fn masked_match(masked: &str, key: &str) -> bool {
    let (Some(i), Some(j)) = (masked.find('*'), masked.rfind('*')) else {
        return masked == key;
    };
    if i == 0 || j < i {
        return masked == key;
    }
    let (prefix, suffix) = (&masked[..i], &masked[j + 1..]);
    key.len() >= prefix.len() + suffix.len() && key.starts_with(prefix) && key.ends_with(suffix)
}

/// 拉模型列表并映射为同步条目。协议优先 anthropic(multi/anthropic 走
/// anthropic 端点;纯 openai 走 openai 端点)。停用模型跳过;不健康仍同步但记 note。
async fn gateway_models(svc: &Service, key: &str) -> BzResult<(Vec<Value>, Vec<String>)> {
    let data = console_call(svc, reqwest::Method::GET, "/api/console/models?page=1&pageSize=200", None)
        .await
        .map_err(|e| other(format!("获取模型列表失败: {}", e.msg())))?;
    let items: Vec<Value> = data.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut models = Vec::new();
    let mut notes = Vec::new();
    let mut unhealthy = 0;
    for m in &items {
        let name = m.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let enabled = m.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        if !enabled || name.is_empty() {
            continue;
        }
        let iface = m.get("interfaceType").and_then(|v| v.as_str()).unwrap_or("");
        let (provider, base_url) = if iface == "openai" {
            ("openai", format!("{}/api/openai", svc.ep.model_gateway))
        } else {
            ("anthropic", format!("{}/api/anthropic", svc.ep.model_gateway))
        };
        let health = m.get("healthStatus").and_then(|v| v.as_str()).unwrap_or("");
        if !health.is_empty() && health != "healthy" {
            unhealthy += 1;
        }
        models.push(json!({
            "name": name,
            "provider": provider,
            "base_url": base_url,
            "api_key": key,
            "model": name,
            "source": SOURCE_BAIZHI,
        }));
    }
    if models.is_empty() {
        notes.push("网关下没有已启用的模型".to_string());
    }
    if unhealthy > 0 {
        notes.push(format!("其中 {unhealthy} 个模型当前健康检查未通过(仍会同步,可能临时抖动)"));
    }
    Ok((models, notes))
}

// ==================== MCP(agent-toolkit)====================

/// agent-toolkit 的 code 合法值:缺失/null 合法,字符串只认 "ok",数字认 0/200。
fn code_ok_toolkit(c: Option<&Value>) -> bool {
    match c {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s == "ok",
        Some(Value::Number(n)) => n.as_i64() == Some(0) || n.as_i64() == Some(200),
        _ => false,
    }
}

/// MCP 网关包壳。与 console 的差异:code 可能是字符串 "ok";
/// 3xx 视为未开通(不跟随重定向,首响应即 302)。
pub(crate) const ENV_MCP: Envelope = Envelope {
    label: "MCP 网关",
    code_ok: code_ok_toolkit,
    check_success: false,
    redirect_msg: Some("当前团队未开通 Agent 工具包"),
    fixed_401: None,
    whole_body_fallback: false,
};

/// agent-toolkit 管理 API 请求。
async fn mcp_call(svc: &Service, method: reqwest::Method, path: &str, body: Option<&Value>) -> BzResult<Value> {
    let target = format!("{}{}", svc.ep.mcp_gateway, path);
    let (data, status) = svc.do_store(&svc.store, method, &target, body).await?;
    unwrap_envelope(&data, status, &ENV_MCP)
}

/// 拉 Agent 工具包服务并确保一把 MCP 密钥,映射为单个 streamable-http 条目。
/// 非致命:任何一步失败仅记 note,不阻断模型同步。
async fn mcp_servers(svc: &Service) -> (Value, Vec<String>) {
    let empty = json!({});

    // 握手:agent-toolkit 的 sl-session 按 host 独立,先 GET / 领取
    let _ = svc
        .do_store(&svc.store, reqwest::Method::GET, &format!("{}/", svc.ep.mcp_gateway), None)
        .await;

    let svc_list = match mcp_call(svc, reqwest::Method::GET, "/api/v1/services", None).await {
        Ok(v) => v,
        Err(e) => {
            let msg = e.msg();
            if msg.contains("未开通") {
                return (empty, vec!["当前团队未开通 Agent 工具包,已跳过 MCP 同步(可在百智云控制台申请开通)".into()]);
            }
            return (empty, vec![format!("获取 MCP 服务失败: {msg}")]);
        }
    };
    let items: Vec<Value> = svc_list.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if items.is_empty() {
        return (empty, vec!["Agent 工具包下没有可用的 MCP 服务".into()]);
    }
    let codes: Vec<String> = items
        .iter()
        .filter_map(|it| it.get("catalog_code").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string))
        .collect();
    let names: Vec<String> = items
        .iter()
        .filter_map(|it| it.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string))
        .collect();

    let (key, note) = ensure_mcp_key(svc, &codes).await;
    if key.is_empty() {
        return (empty, vec![note]);
    }
    let out = json!({
        MCP_ENTRY_NAME: {
            "url": format!("{}/mcp", svc.ep.mcp_gateway),
            "headers": { "Authorization": format!("Bearer {key}") },
            "source": SOURCE_BAIZHI,
        }
    });
    let mut notes = vec![format!("MCP 已同步(含 {} 个服务: {})", items.len(), names.join("、"))];
    if !note.is_empty() {
        notes.push(note);
    }
    (out, notes)
}

fn id_path(item: &Value) -> String {
    match item.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// 确保拿到一把可用的 MCP 明文密钥;返回 (key, note)。
/// 与模型网关不同,这里明文可经 reveal 随时取回。
async fn ensure_mcp_key(svc: &Service, tool_codes: &[String]) -> (String, String) {
    let list = match mcp_call(svc, reqwest::Method::GET, "/api/v1/api-keys", None).await {
        Ok(v) => v,
        Err(e) => return (String::new(), format!("获取 MCP 密钥列表失败: {}", e.msg())),
    };
    let items: Vec<Value> = list.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    // 已有可用密钥(优先同名)→ reveal 取明文;停用的同名密钥先启用
    let mut pick: Option<&Value> = None;
    for it in &items {
        let status = it.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let name = it.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if status == "enabled" && (pick.is_none() || name == SYNC_KEY_NAME) {
            pick = Some(it);
        }
    }
    let mut picked = pick.cloned();
    if picked.is_none() {
        for it in &items {
            let name = it.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name == SYNC_KEY_NAME {
                // 只碰自家条目,不动用户手工停用的密钥
                if let Err(e) = mcp_call(
                    svc,
                    reqwest::Method::POST,
                    &format!("/api/v1/api-keys/{}/enable", id_path(it)),
                    None,
                )
                .await
                {
                    return (String::new(), format!("重新启用 MCP 密钥失败: {}", e.msg()));
                }
                picked = Some(it.clone());
                break;
            }
        }
    }
    if let Some(it) = picked {
        let rev = match mcp_call(svc, reqwest::Method::GET, &format!("/api/v1/api-keys/{}/reveal", id_path(&it)), None).await {
            Ok(v) => v,
            Err(e) => return (String::new(), format!("获取 MCP 密钥明文失败: {}", e.msg())),
        };
        let key = rev.get("key").and_then(|v| v.as_str()).unwrap_or("");
        if key.is_empty() {
            return (String::new(), "MCP 密钥明文响应为空".into());
        }
        return (key.to_string(), String::new());
    }

    // 没有任何可用密钥 → 新建(授权全部服务)
    let created = match mcp_call(
        svc,
        reqwest::Method::POST,
        "/api/v1/api-keys",
        Some(&json!({ "name": SYNC_KEY_NAME, "tool_codes": tool_codes })),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => return (String::new(), format!("创建 MCP 密钥失败: {}", e.msg())),
    };
    let key = created.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if key.is_empty() {
        return (String::new(), "创建 MCP 密钥成功但响应未含明文".into());
    }
    let status = created.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if !status.is_empty() && status != "enabled" {
        if let Err(e) = mcp_call(
            svc,
            reqwest::Method::POST,
            &format!("/api/v1/api-keys/{}/enable", id_path(&created)),
            None,
        )
        .await
        {
            return (String::new(), format!("启用新建 MCP 密钥失败: {}", e.msg()));
        }
    }
    (key, String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 对照 Go sync_test.go 的 maskedMatch 断言
    #[test]
    fn masked_match_cases() {
        assert!(masked_match("sk-7c263***27e2", "sk-7c263abcdef27e2"));
        assert!(!masked_match("sk-7c263***27e2", "sk-9999abcdef27e2"));
        assert!(!masked_match("sk-7c263***27e2", "sk-7c263abcdefffff"));
        // 无掩码 = 全等比较
        assert!(masked_match("sk-full", "sk-full"));
        assert!(!masked_match("sk-full", "sk-other"));
        // 明文过短(短于前缀+后缀)不匹配
        assert!(!masked_match("sk-7c263***27e2", "sk-7"));
    }

    #[test]
    fn pick_name_skips_taken() {
        let items = vec![json!({"name": "MonkeyCode"}), json!({"name": "MonkeyCode-2"})];
        assert_eq!(pick_key_name(&items).map_err(|e| e.msg()).unwrap(), "MonkeyCode-3");
        assert_eq!(pick_key_name(&[]).map_err(|e| e.msg()).unwrap(), "MonkeyCode");
    }
}
