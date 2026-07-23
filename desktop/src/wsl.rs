// WSL 内核支持:Windows 上壳把内核 spawn 进 WSL 发行版(wsl.exe -d <d> --exec)。
// WSL2 localhostForwarding(默认开)让 WSL 内监听的 127.0.0.1:port 可从
// Windows 侧直连,origin 不变,壳的端口/令牌/探活机制全部原样复用。
//
// 本模块全平台编译:Linux 开发机可经 MC_WSL_EXE 指向假 wsl 脚本冒烟整条
// 代码路径;仅 CREATE_NO_WINDOW 之类 Windows 细节 cfg 局部化。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// wsl 可执行名(MC_WSL_EXE 覆盖,开发机 shim 冒烟用)。
pub fn wsl_exe() -> String {
    std::env::var("MC_WSL_EXE").unwrap_or_else(|_| "wsl.exe".into())
}

/// guest 内 Linux 绝对路径 → Windows 侧可见的 UNC 路径(\\wsl$\<发行版>\…)。
/// 壳跨 host/guest 的文件系统访问统一走这里(repo 浏览、附件上传共用);
/// M3(ohmy WSL 模式)若改用 \\wsl.localhost\ 等新形式,此函数是唯一改动点。
pub fn unc_path(distro: &str, guest_path: &str) -> PathBuf {
    PathBuf::from(format!(r"\\wsl$\{}{}", distro, guest_path.replace('/', r"\")))
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
/// Windows 直接读取当前用户的 Lxss 注册表，避免为了填一个下拉框启动
/// wsl.exe（会唤醒 WSL，部分机器还会闪出控制台窗口）。
pub fn list_distros() -> Vec<String> {
    #[cfg(windows)]
    {
        match list_distros_from_registry() {
            Ok(names) => names,
            Err(e) => {
                eprintln!("[desktop] 枚举 WSL 发行版失败: {e}");
                Vec::new()
            }
        }
    }

    // Linux 开发机保留 MC_WSL_EXE 假脚本入口，用于冒烟 WSL 命令链路。
    #[cfg(not(windows))]
    {
        if std::env::var("MC_WSL_EXE").is_err() {
            return Vec::new();
        }
        match run_wsl(&["-l".into(), "-q".into()], Duration::from_secs(10)) {
            Ok(out) => parse_distro_list(&out),
            Err(e) => {
                eprintln!("[desktop] 枚举 WSL 发行版失败: {e}");
                Vec::new()
            }
        }
    }
}

#[cfg(windows)]
fn list_distros_from_registry() -> Result<Vec<String>, String> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_READ, REG_SZ,
    };

    struct RegKey(HKEY);
    impl Drop for RegKey {
        fn drop(&mut self) {
            // SAFETY:句柄只由本函数成功的 RegOpenKeyExW 创建，并由此 guard
            // 唯一持有；预定义的 HKEY_CURRENT_USER 不放入 guard。
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn open_key(parent: HKEY, path: &str) -> Result<RegKey, String> {
        let path = wide(path);
        let mut key = HKEY::default();
        // SAFETY:path 是以 NUL 结尾且在调用期间存活的 UTF-16；key 是有效
        // 输出指针。只请求 KEY_READ，不会写注册表或触发 UAC。
        let status =
            unsafe { RegOpenKeyExW(parent, PCWSTR(path.as_ptr()), None, KEY_READ, &mut key) };
        if status != ERROR_SUCCESS {
            return Err(format!("打开注册表项失败({})", status.0));
        }
        Ok(RegKey(key))
    }

    fn string_value(key: HKEY, name: &str) -> Result<String, String> {
        let name = wide(name);
        let mut value_type = Default::default();
        let mut byte_len = 0u32;
        // SAFETY:name 是有效的 NUL 结尾 UTF-16；第一次查询只获取长度和类型。
        let status = unsafe {
            RegQueryValueExW(
                key,
                PCWSTR(name.as_ptr()),
                None,
                Some(&mut value_type),
                None,
                Some(&mut byte_len),
            )
        };
        if status != ERROR_SUCCESS || value_type != REG_SZ {
            return Err(format!("读取注册表字符串长度失败({})", status.0));
        }

        let mut value = vec![0u16; (byte_len as usize).div_ceil(2).max(1)];
        // SAFETY:value 以 u16 对齐，容量至少为注册表报告的 byte_len；API
        // 按字节写入，返回后仍按 UTF-16 解释。
        let status = unsafe {
            RegQueryValueExW(
                key,
                PCWSTR(name.as_ptr()),
                None,
                Some(&mut value_type),
                Some(value.as_mut_ptr().cast()),
                Some(&mut byte_len),
            )
        };
        if status != ERROR_SUCCESS || value_type != REG_SZ {
            return Err(format!("读取注册表字符串失败({})", status.0));
        }
        let units = (byte_len as usize / 2).min(value.len());
        let value = &value[..units];
        let end = value.iter().position(|&u| u == 0).unwrap_or(value.len());
        Ok(String::from_utf16_lossy(&value[..end]))
    }

    let lxss = open_key(
        HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\Lxss",
    )?;
    let mut names = Vec::new();
    let mut index = 0u32;
    loop {
        // WSL 的子项名是 GUID；留 256 个 UTF-16 单元也兼容未来扩展。
        let mut subkey_name = [0u16; 256];
        let mut name_len = (subkey_name.len() - 1) as u32;
        // SAFETY:缓冲区和长度指针在调用期间有效；其余可选输出均不需要。
        let status = unsafe {
            RegEnumKeyExW(
                lxss.0,
                index,
                Some(PWSTR(subkey_name.as_mut_ptr())),
                &mut name_len,
                None,
                None,
                None,
                None,
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        if status != ERROR_SUCCESS {
            return Err(format!("枚举注册表子项失败({})", status.0));
        }
        index += 1;

        let subkey_name = String::from_utf16_lossy(&subkey_name[..name_len as usize]);
        let Ok(subkey) = open_key(lxss.0, &subkey_name) else {
            continue;
        };
        let Ok(name) = string_value(subkey.0, "DistributionName") else {
            continue;
        };
        if !name.is_empty() && !name.starts_with("docker-desktop") {
            names.push(name);
        }
    }
    names.sort_unstable_by_key(|name| name.to_lowercase());
    names.dedup();
    Ok(names)
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
#[allow(dead_code)] // M3(ohmy WSL 模式)复用:路径翻译 + 预热
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

/// Windows 上 GUI 进程 spawn 控制台子系统 exe 会弹黑窗,统一在此加
/// CREATE_NO_WINDOW(非 Windows 空操作)。壳内所有 std Command 的
/// spawn 点(引擎/git/wsl)共用这一处。
pub(crate) fn no_console(cmd: &mut Command) {
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
    fn unc_path_mapping() {
        assert_eq!(
            unc_path("Ubuntu-22.04", "/home/u/proj"),
            PathBuf::from(r"\\wsl$\Ubuntu-22.04\home\u\proj")
        );
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
