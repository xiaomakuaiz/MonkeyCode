// MonkeyCode 本地桌面客户端 —— Tauri 壳。
//
// 职责边界:壳持有**应用配置**(模型列表等)与宿主事务(进程生命周期、
// 托盘、设置窗口);agent 内核只是壳拉起的子进程,配置经环境变量注入
// (MC_AGENT_MODELS 指向壳写出的模型清单),内核零管理职责。
// 业务与对话 UI 在 Go 内核;壳与内核经 localhost WS 帧协议解耦。
//
// 生命周期:
//   首启无配置 → 设置窗口;保存 → 写清单 → 拉起内核 → 主窗口加载内核 UI。
//   随时修改 → 托盘"设置" → 保存即重启内核(会话在磁盘,重连自动回放)。
//   关主窗口只隐藏(任务继续跑),托盘"退出"才真正退出并回收内核。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Theme, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// ==================== 应用配置(壳持有) ====================

/// 一个模型配置项(与内核 MC_AGENT_MODELS 清单同构)。
#[derive(Clone, Serialize, Deserialize, Default)]
struct ModelEntry {
    name: String,
    #[serde(default)]
    provider: String, // anthropic | openai
    base_url: String,
    api_key: String,
    model: String,
    #[serde(default)]
    default: bool,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct DesktopConfig {
    #[serde(default)]
    models: Vec<ModelEntry>,
    /// MCP 服务器(name → 配置,与内核 mcp.json 的 mcpServers 同构;
    /// 壳不解释内容,原样写盘由内核校验)
    #[serde(default)]
    mcp_servers: serde_json::Map<String, serde_json::Value>,
}

impl DesktopConfig {
    fn valid(&self) -> bool {
        !self.models.is_empty()
            && self.models.iter().all(|m| {
                !m.name.is_empty() && !m.base_url.is_empty() && !m.api_key.is_empty() && !m.model.is_empty()
            })
    }
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))
}

fn load_config(app: &AppHandle) -> DesktopConfig {
    let Ok(dir) = config_dir(app) else {
        return DesktopConfig::default();
    };
    fs::read(dir.join("config.json"))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

/// 内核消费的配置文件路径集合。
struct KernelFiles {
    models: PathBuf,
    mcp: PathBuf,
}

/// 写应用配置 + 内核清单(模型 + MCP,均 0600,含密钥)。
fn save_config_files(app: &AppHandle, cfg: &DesktopConfig) -> Result<KernelFiles, String> {
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
    Ok(files)
}

// ==================== 状态 ====================

/// 内核子进程句柄(退出时回收)。子进程存在 ⇔ 关主窗口隐藏到托盘。
struct Kernel(Mutex<Option<Child>>);

/// 托盘是否可用;不可用时关窗直接退出(否则窗口藏起来就找不回了)。
struct TrayReady(AtomicBool);

/// 当前内核 UI 地址(设置页"返回"时导航回来)。
struct KernelUrl(Mutex<Option<String>>);

/// 托盘句柄(系统明暗主题切换时换图标)。
struct Tray(Mutex<Option<TrayIcon>>);

/// 托盘图标:透明背景的图形版(adaptive-icon,无白色圆角底板),
/// 彩色图形在明暗菜单栏下均可辨,两种主题共用。
fn tray_icon_for(_theme: Theme) -> Image<'static> {
    Image::from_bytes(include_bytes!("../icons/tray.png")).expect("托盘图标解码失败")
}

/// 主题变化时更新托盘图标。
fn sync_tray_theme(app: &AppHandle, theme: Theme) {
    if let Some(tray) = app.state::<Tray>().0.lock().unwrap().as_ref() {
        let _ = tray.set_icon(Some(tray_icon_for(theme)));
    }
}

// ==================== Tauri 命令(设置页调用) ====================

#[tauri::command]
fn get_config(app: AppHandle) -> DesktopConfig {
    load_config(&app)
}

/// 错误页与内核 UI 的"设置"按钮调用。
#[tauri::command]
fn open_settings_window(app: AppHandle) {
    eprintln!("[mc-desktop] IPC: open_settings_window");
    open_settings(&app);
}

/// 设置页"返回"(不保存):主窗口导航回内核 UI;首启独立设置窗则直接关闭。
#[tauri::command]
fn close_settings(app: AppHandle) {
    let kernel_url = app.state::<KernelUrl>().0.lock().unwrap().clone();
    if let (Some(url), Some(win)) = (kernel_url, app.get_webview_window("main")) {
        if let Ok(parsed) = url.parse::<Url>() {
            let _ = win.navigate(parsed);
            return;
        }
    }
    if let Some(sw) = app.get_webview_window("settings") {
        let _ = sw.close();
    }
}

/// 保存配置并(重)启内核,主窗口切到内核 UI。设置页保存按钮调用。
#[tauri::command]
fn save_config(app: AppHandle, config: DesktopConfig) -> Result<(), String> {
    if !config.valid() {
        return Err("至少需要一个完整的模型配置(名称/接口地址/API Key/模型标识)".into());
    }
    let files = save_config_files(&app, &config)?;

    // 重启内核(阻塞等就绪,最多 15 秒);窗口操作回主线程
    let (child, port, token) = start_kernel(&files)?;
    if let Some(mut old) = app.state::<Kernel>().0.lock().unwrap().replace(child) {
        let _ = old.kill();
        let _ = old.wait();
    }
    let url = format!("http://127.0.0.1:{port}/#{token}");
    app.run_on_main_thread({
        let app = app.clone();
        move || show_kernel_ui(&app, &url)
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ==================== 窗口 ====================

/// 主窗口显示内核 UI(已存在则导航复用,否则创建)。顺手关掉设置窗口。
fn show_kernel_ui(app: &AppHandle, url: &str) {
    app.state::<KernelUrl>().0.lock().unwrap().replace(url.to_string());
    let parsed: Url = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[mc-desktop] 内核 URL 无效: {e}");
            return;
        }
    };
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.navigate(parsed);
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
            .title("MonkeyCode")
            .inner_size(1200.0, 800.0);
        // 无头冒烟探针:页面加载后自动走一遍 远程页→IPC→设置窗 链路,
        // 结果写进 document.title(无头环境唯一可靠的回读通道)
        if std::env::var("MC_DESKTOP_IPC_PROBE").is_ok() {
            builder = builder.initialization_script(
                "const report = (m) => fetch('http://127.0.0.1:18240/probe/' + encodeURIComponent(m), {mode:'no-cors'}).catch(()=>{}); \
                 report('script-injected'); \
                 setTimeout(() => { \
                   if (location.protocol !== 'http:') return; /* 仅在内核 UI 页触发,避免设置页循环 */ \
                   if (!window.__TAURI__ || !window.__TAURI__.core) { report('no-tauri'); return; } \
                   window.__TAURI__.core.invoke('open_settings_window') \
                     .then(() => report('invoke-ok')) \
                     .catch((e) => report('invoke-err:' + String(e).slice(0, 80))); \
                 }, 3000);",
            );
        }
        let _ = builder.build();
    }
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(theme) = win.theme() {
            sync_tray_theme(app, theme);
        }
    }
    if let Some(sw) = app.get_webview_window("settings") {
        let _ = sw.close();
    }
}

/// 打开设置:主窗口存在时在窗口内切到设置页(单窗口体验);
/// 首启(无主窗口)时才单独开设置窗。
fn open_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(url) = app_page_url("settings.html").parse::<Url>() {
            let _ = win.navigate(url);
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
            return;
        }
    }
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("MonkeyCode 设置")
        .inner_size(640.0, 680.0)
        .build();
}

/// 应用自带页面的完整 URL(与 Tauri 打包页面的 origin 约定一致)。
fn app_page_url(page: &str) -> String {
    if cfg!(windows) {
        format!("http://tauri.localhost/{page}")
    } else {
        format!("tauri://localhost/{page}")
    }
}

/// 打开错误页(内核启动故障等宿主级错误)。
fn open_error_page(app: &AppHandle, msg: &str) {
    let url = PathBuf::from(format!("index.html#{}", urlencode(msg)));
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url))
        .title("MonkeyCode")
        .inner_size(720.0, 480.0)
        .build();
}

fn main() {
    eprintln!("[mc-desktop] main 进入");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Kernel(Mutex::new(None)))
        .manage(TrayReady(AtomicBool::new(true)))
        .manage(KernelUrl(Mutex::new(None)))
        .manage(Tray(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            open_settings_window,
            close_settings
        ])
        .setup(|app| {
            // 托盘失败只降级(无托盘宿主的桌面环境),不阻塞
            if let Err(e) = setup_tray(app.handle()) {
                eprintln!("[mc-desktop] 托盘创建失败(关窗将直接退出): {e}");
                app.state::<TrayReady>().0.store(false, Ordering::Relaxed);
            }

            let cfg = load_config(app.handle());
            if !cfg.valid() {
                eprintln!("[mc-desktop] 尚未配置模型,打开设置");
                open_settings(app.handle());
                return Ok(());
            }
            let files = save_config_files(app.handle(), &cfg)?; // 刷新清单文件
            match start_kernel(&files) {
                Ok((child, port, token)) => {
                    eprintln!("[mc-desktop] 内核就绪: 127.0.0.1:{port}");
                    app.state::<Kernel>().0.lock().unwrap().replace(child);
                    show_kernel_ui(app.handle(), &format!("http://127.0.0.1:{port}/#{token}"));
                }
                Err(e) => {
                    eprintln!("[mc-desktop] 内核启动失败: {e}");
                    open_error_page(app.handle(), &e);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::ThemeChanged(theme) = event {
                sync_tray_theme(window.app_handle(), *theme);
            }
            // 主窗口:内核在跑且托盘可用时关窗只隐藏;设置/错误页正常关闭
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let app = window.app_handle();
                let kernel_running = app.state::<Kernel>().0.lock().unwrap().is_some();
                let tray_ready = app.state::<TrayReady>().0.load(Ordering::Relaxed);
                if kernel_running && tray_ready {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("启动 Tauri 失败")
        .run(|app, event| match event {
            // 兜底:托盘可用时窗口全部关闭不结束进程(托盘常驻);
            // app.exit() 显式退出或托盘不可用时放行
            RunEvent::ExitRequested { api, code, .. }
                if code.is_none() && app.state::<TrayReady>().0.load(Ordering::Relaxed) =>
            {
                api.prevent_exit();
            }
            RunEvent::Exit => {
                if let Some(mut child) = app.state::<Kernel>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            _ => {}
        });
}

/// 创建托盘:菜单(显示窗口/设置/退出)+ 左键单击恢复窗口。
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 MonkeyCode", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

    let tray = TrayIconBuilder::with_id("main")
        .icon(tray_icon_for(Theme::Light))
        .tooltip("MonkeyCode")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_any_window(app),
            "settings" => open_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_any_window(tray.app_handle());
            }
        });
    let handle = tray.build(app)?;
    app.state::<Tray>().0.lock().unwrap().replace(handle);
    Ok(())
}

/// 恢复主窗口;没有主窗口(如首启未配置)则打开设置。
fn show_any_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    } else {
        open_settings(app);
    }
}

// ==================== 内核进程 ====================

/// 启动内核:配置经环境变量注入(不走 argv,避免泄漏进 ps)。
/// 返回 (子进程, 端口, 令牌)。
fn start_kernel(files: &KernelFiles) -> Result<(Child, u16, String), String> {
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
        .env("MC_AGENT_MODELS", &files.models)
        .env("MC_AGENT_MCP_CONFIG", &files.mcp)
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
            return Err(format!("内核进程提前退出({status}),请检查模型配置是否有效"));
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
