// MonkeyCode 本地桌面客户端 —— Tauri 薄壳。
//
// 职责(刻意最小化):生成访问令牌 → 挑选空闲端口 → 拉起 mc-agent serve
// 子进程 → 等待就绪 → 打开窗口加载内核 UI → 退出时回收子进程。
// 业务全部在 Go 内核;壳与内核经 localhost WS 帧协议解耦,后续可
// 替换为独立 React UI 而不动内核。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// 内核子进程句柄(退出时回收)。
struct Kernel(Mutex<Option<Child>>);

fn main() {
    eprintln!("[mc-desktop] main 进入");
    tauri::Builder::default()
        .manage(Kernel(Mutex::new(None)))
        .setup(|app| {
            eprintln!("[mc-desktop] setup 进入,开始启动内核");
            match start_kernel() {
                Ok((child, port, token)) => {
                    eprintln!("[mc-desktop] 内核就绪: 127.0.0.1:{port}");
                    app.state::<Kernel>().0.lock().unwrap().replace(child);
                    let url = format!("http://127.0.0.1:{port}/#{token}")
                        .parse()
                        .expect("kernel url");
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                        .title("MonkeyCode")
                        .inner_size(1200.0, 800.0)
                        .build()?;
                }
                Err(e) => {
                    eprintln!("[mc-desktop] 内核启动失败: {e}");
                    // 打开占位页展示错误,不静默退出
                    let url = format!("index.html#{}", urlencode(&e)).parse()?;
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url))
                        .title("MonkeyCode")
                        .inner_size(720.0, 480.0)
                        .build()?;
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动 Tauri 失败")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Kernel>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

/// 启动内核:返回 (子进程, 端口, 令牌)。
fn start_kernel() -> Result<(Child, u16, String), String> {
    let bin = find_agent().ok_or_else(|| {
        "找不到 mc-agent 可执行文件(查找顺序: MC_AGENT_BIN 环境变量 → 应用同目录 → PATH)".to_string()
    })?;

    let port = free_port().map_err(|e| format!("无法分配本地端口: {e}"))?;
    let token = rand_token();

    let mut child = Command::new(&bin)
        .args([
            "serve",
            "--addr",
            &format!("127.0.0.1:{port}"),
            "--token",
            &token,
            // 壳持有内核 stdin 管道:壳以任何方式退出(含被 kill),
            // 管道关闭,内核随之退出,不留孤儿进程
            "--watch-stdin",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("启动内核失败({}): {e}", bin.display()))?;

    // 等待内核就绪(端口可连接);失败时带上退出状态
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(200),
        )
        .is_ok()
        {
            return Ok((child, port, token));
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "内核进程提前退出({status})。常见原因:未配置模型,请先运行 mc-agent config set"
            ));
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("内核在 15 秒内未就绪".to_string());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// 查找内核二进制:MC_AGENT_BIN → 应用同目录 → PATH。
fn find_agent() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MC_AGENT_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let name = if cfg!(windows) { "mc-agent.exe" } else { "mc-agent" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // PATH 查找(含 ~/.local/bin,GUI 环境下 PATH 可能不含它)
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        paths.push(PathBuf::from(home).join(".local/bin"));
    }
    paths.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn rand_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("getrandom");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
