// 对话附件上传/回读。落盘 <workdir>/.monkeycode/uploads/(会话工作区内,
// 模型经相对路径 Read 查看)。回读返回 data URL(Tauri 下 <img> 无法带鉴权头,
// 又不想开 asset scope 到任意工作区,小图 base64 内联最稳)。

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
/// 工作区根(WSL 模式下映射 UNC)。空 workdir 会让相对路径落到进程 cwd
/// (打包应用下是主目录)——硬错误。
fn uploads_root(workdir: &str, wsl_distro: Option<&str>) -> Result<PathBuf, String> {
    if workdir.trim().is_empty() {
        return Err("会话缺少工作目录,无法定位附件目录".into());
    }
    Ok(match wsl_distro {
        Some(d) => crate::wsl::unc_path(d, workdir),
        None => PathBuf::from(workdir),
    })
}

fn uploads_dir(workdir: &str, wsl_distro: Option<&str>) -> Result<PathBuf, String> {
    Ok(uploads_root(workdir, wsl_distro)?.join(".monkeycode").join("uploads"))
}

/// 保存原始字节到上传目录(浏览器截图等壳内生成物),返回工作区相对路径。
pub fn save_raw(workdir: &str, wsl_distro: Option<&str>, name: &str, data: &[u8]) -> Result<String, String> {
    let dir = uploads_dir(workdir, wsl_distro)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建上传目录失败: {e}"))?;
    let gi = dir.join(".gitignore");
    if !gi.exists() {
        let _ = std::fs::write(&gi, "*\n");
    }
    std::fs::write(dir.join(name), data).map_err(|e| format!("写入失败: {e}"))?;
    Ok(format!(".monkeycode/uploads/{name}"))
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

    let dir = uploads_dir(workdir, wsl_distro)?;
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
    Ok(json!({ "path": format!(".monkeycode/uploads/{fname}") }))
}

/// 回读已上传文件为 data URL(UI 气泡缩略图)。仅允许 uploads 目录内的文件名。
pub fn read_data_url(workdir: &str, wsl_distro: Option<&str>, path: &str) -> Result<String, String> {
    // 回读按消息内存储的相对路径走;只放行工作区内的上传目录,
    // 拒绝越界与绝对路径
    let rel = path.trim_start_matches("./");
    let in_uploads = rel.starts_with(".monkeycode/uploads/");
    if !in_uploads || rel.contains('\\') || rel.split('/').any(|seg| seg == "..") {
        return Err("非法附件路径".into());
    }
    let p = uploads_root(workdir, wsl_distro)?.join(rel);
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
