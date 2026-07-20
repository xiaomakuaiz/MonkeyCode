// 对话附件上传/回读(agent/internal/server handleUpload 的 Rust 移植)。
// 落盘 <workdir>/.mc-agent/uploads/(目录约定与 mc-agent 一致:双引擎共用,
// 模型经 read_file 按路径查看)。回读返回 data URL(Tauri 下 <img> 无法带
// 鉴权头,又不想开 asset scope 到任意工作区,小图 base64 内联最稳)。

use std::path::PathBuf;

use base64::Engine as _;
use serde_json::{json, Value};

const UPLOAD_MAX_BYTES: usize = 20 * 1024 * 1024;

/// 常见图片 MIME → 扩展名(剪贴板图片无文件名时的命名兜底)。
fn image_ext(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some(".png"),
        "image/jpeg" => Some(".jpg"),
        "image/gif" => Some(".gif"),
        "image/webp" => Some(".webp"),
        _ => None,
    }
}

/// 清洗上传文件名:去路径、去首尾点、白名单字符;超长或清空后为空返回 None。
fn sanitize_name(name: &str) -> Option<String> {
    let base = name.replace('\\', "/");
    let base = base.rsplit('/').next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|r| match r {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => r,
            '\u{4e00}'..='\u{9fff}' => r, // 常用汉字
            _ => '_',
        })
        .collect();
    let out = cleaned.trim_matches(['.', '_']).to_string();
    if out.is_empty() || out.len() > 120 {
        None
    } else {
        Some(out)
    }
}

/// 工作区 uploads 目录(WSL 模式下 workdir 转 UNC 访问)。
fn uploads_dir(workdir: &str, wsl_distro: Option<&str>) -> PathBuf {
    let root = match wsl_distro {
        Some(d) => PathBuf::from(format!(r"\\wsl$\{}{}", d, workdir.replace('/', r"\"))),
        None => PathBuf::from(workdir),
    };
    root.join(".mc-agent").join("uploads")
}

/// 保存附件,返回 {path: 工作区相对路径}。
pub fn save(workdir: &str, wsl_distro: Option<&str>, name: &str, media_type: &str, data_b64: &str) -> Result<Value, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|_| "文件数据无效".to_string())?;
    if raw.is_empty() {
        return Err("文件数据无效".into());
    }
    if raw.len() > UPLOAD_MAX_BYTES {
        return Err(format!("文件过大({} 字节,上限 {})", raw.len(), UPLOAD_MAX_BYTES));
    }

    let dir = uploads_dir(workdir, wsl_distro);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建上传目录失败: {e}"))?;
    // uploads 不入库:目录内放自免疫的 .gitignore(仅首次创建)
    let gi = dir.join(".gitignore");
    if !gi.exists() {
        let _ = std::fs::write(&gi, "*\n");
    }

    // 命名:优先保留原始文件名(清洗后);无名(剪贴板截图)按时间戳
    let mut fname = sanitize_name(name).unwrap_or_else(|| {
        let (prefix, ext) = match image_ext(media_type) {
            Some(e) => ("img-", e),
            None => ("file-", ".bin"),
        };
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("{prefix}{ts}{ext}")
    });
    // 重名追加序号(插在扩展名前)
    let (stem, ext) = match fname.rfind('.') {
        Some(i) if i > 0 => (fname[..i].to_string(), fname[i..].to_string()),
        _ => (fname.clone(), String::new()),
    };
    let mut i = 2;
    while dir.join(&fname).exists() {
        fname = format!("{stem}-{i}{ext}");
        i += 1;
    }
    std::fs::write(dir.join(&fname), &raw).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(json!({ "path": format!(".mc-agent/uploads/{fname}") }))
}

/// 回读已上传文件为 data URL(UI 气泡缩略图)。仅允许 uploads 目录内的文件名。
pub fn read_data_url(workdir: &str, wsl_distro: Option<&str>, path: &str) -> Result<String, String> {
    let name = path.rsplit('/').next().unwrap_or("");
    if name.is_empty() || name.contains("..") || name.contains('\\') {
        return Err("非法文件名".into());
    }
    let p = uploads_dir(workdir, wsl_distro).join(name);
    let data = std::fs::read(&p).map_err(|e| format!("读取失败: {e}"))?;
    let mime = match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        // 非图片一律按二进制下发,防 html 等在应用源下渲染执行
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&data)))
}
