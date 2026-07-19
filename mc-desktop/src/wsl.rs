// WSL 内核支持:Windows 上壳把内核 spawn 进 WSL 发行版(wsl.exe -d <d> --exec)。
// WSL2 localhostForwarding(默认开)让 WSL 内监听的 127.0.0.1:port 可从
// Windows 侧直连,origin 不变,壳的端口/令牌/探活机制全部原样复用。
//
// 本模块全平台编译:Linux 开发机可经 MC_WSL_EXE 指向假 wsl 脚本冒烟整条
// 代码路径;仅 CREATE_NO_WINDOW 之类 Windows 细节 cfg 局部化。

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// wsl 可执行名(MC_WSL_EXE 覆盖,开发机 shim 冒烟用)。
pub fn wsl_exe() -> String {
    std::env::var("MC_WSL_EXE").unwrap_or_else(|_| "wsl.exe".into())
}

/// kernel_env 配置值解析:"wsl:<distro>" → Some(distro),其余(本机)→ None。
pub fn distro_of(kernel_env: &str) -> Option<&str> {
    kernel_env.strip_prefix("wsl:").filter(|d| !d.is_empty())
}

/// 解码 wsl.exe 输出:老版本以 UTF-16LE 打印(WSL_UTF8=1 只有新版认),
/// 以 NUL 字节嗅探区分;去 BOM 与 \r。
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    let s = if bytes.contains(&0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    s.replace('\u{feff}', "").replace('\r', "")
}

/// 运行一次 wsl.exe 并收集输出(轮询 try_wait 实现超时;输出都是小体量,
/// 管道缓冲足够,不会因未及时读取而阻塞子进程)。
pub fn run_wsl(args: &[String], timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new(wsl_exe());
    cmd.args(args)
        .env("WSL_UTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 {} 失败: {e}", wsl_exe()))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("wsl 命令超时({}s): {}", timeout.as_secs(), args.join(" ")));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("等待 wsl 进程失败: {e}"));
            }
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = decode_wsl_output(&out.stdout);
    if !out.status.success() {
        let stderr = decode_wsl_output(&out.stderr);
        let msg = if stderr.trim().is_empty() { &stdout } else { &stderr };
        return Err(format!("wsl 命令失败({}): {}", out.status, msg.trim()));
    }
    Ok(stdout)
}

/// 枚举 WSL 发行版(设置视图"运行环境"下拉用);未装 WSL/任何失败 → 空。
pub fn list_distros() -> Vec<String> {
    if cfg!(not(windows)) && std::env::var("MC_WSL_EXE").is_err() {
        return Vec::new();
    }
    match run_wsl(&["-l".into(), "-q".into()], Duration::from_secs(10)) {
        Ok(out) => parse_distro_list(&out),
        Err(e) => {
            eprintln!("[mc-desktop] 枚举 WSL 发行版失败: {e}");
            Vec::new()
        }
    }
}

fn parse_distro_list(out: &str) -> Vec<String> {
    out.lines()
        .map(str::trim)
        // docker-desktop* 是 Docker Desktop 的后端盘,不是用户开发环境
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .map(String::from)
        .collect()
}

/// 预热 VM + 校验发行版可运行 + 批量把 Windows 路径翻译为发行版内 Linux 路径,
/// 一次 wsl 调用完成(VM 冷启的秒数在此吸收,45s 预算)。
/// 返回与 win_paths 一一对应的 Linux 路径。
pub fn prepare(distro: &str, win_paths: &[&Path]) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec![
        "-d".into(),
        distro.into(),
        "--exec".into(),
        "/bin/sh".into(),
        "-c".into(),
        r#"for p in "$@"; do wslpath -u "$p" || exit 1; done"#.into(),
        "sh".into(),
    ];
    args.extend(win_paths.iter().map(|p| p.to_string_lossy().into_owned()));
    let out = run_wsl(&args, Duration::from_secs(45)).map_err(|e| {
        format!(
            "无法在 WSL 发行版 {distro} 中准备内核: {e}\n排查:`wsl -l -v` 确认发行版存在且为 WSL2;\
             系统睡眠恢复后异常可先执行 `wsl --shutdown` 再重启应用。"
        )
    })?;
    let lines: Vec<String> = out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.len() != win_paths.len() {
        return Err(format!(
            "WSL 路径翻译结果异常(期望 {} 行,得到 {} 行): {}",
            win_paths.len(),
            lines.len(),
            out.trim()
        ));
    }
    Ok(lines)
}

fn no_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_utf16le_with_bom_and_crlf() {
        // BOM + "Ubuntu\r\nDebian\r\n" 的 UTF-16LE 编码
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
        for u in "Ubuntu\r\nDebian\r\n".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_wsl_output(&bytes), "Ubuntu\nDebian\n");
    }

    #[test]
    fn decode_utf8_passthrough() {
        assert_eq!(decode_wsl_output("Ubuntu-22.04\n发行版\n".as_bytes()), "Ubuntu-22.04\n发行版\n");
    }

    #[test]
    fn distro_of_parsing() {
        assert_eq!(distro_of("wsl:Ubuntu-22.04"), Some("Ubuntu-22.04"));
        assert_eq!(distro_of(""), None);
        assert_eq!(distro_of("wsl:"), None);
        assert_eq!(distro_of("Ubuntu"), None);
    }

    #[test]
    fn distro_list_filtering() {
        assert_eq!(
            parse_distro_list("Ubuntu-22.04\n\ndocker-desktop\ndocker-desktop-data\n Debian \n"),
            vec!["Ubuntu-22.04".to_string(), "Debian".to_string()]
        );
    }
}
