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
use tauri::{AppHandle, Emitter, Manager, RunEvent, Theme, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// ==================== 应用配置(壳持有) ====================

fn json_array() -> serde_json::Value {
    serde_json::Value::Array(vec![])
}
fn json_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// 应用配置。壳只认顶层两个 key,内容**原样透传**不做业务校验——
/// schema 的唯一来源是内核(config.LoadModels)与设置视图表单(agent/ui),
/// 壳零字段知识;非法内容由内核以零模型模式容忍并经 UI 引导修复。
#[derive(Clone, Serialize, Deserialize)]
struct DesktopConfig {
    #[serde(default = "json_array")]
    models: serde_json::Value,
    /// MCP 服务器(name → 配置,与内核 mcp.json 的 mcpServers 同构)
    #[serde(default = "json_object")]
    mcp_servers: serde_json::Value,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self { models: json_array(), mcp_servers: json_object() }
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

/// 停止内核:关 stdin 管道触发内核优雅退出(--watch-stdin 契约:内核取消
/// 进行中的轮次并落盘会话消息快照),超时未退再强杀兜底。
/// 不可直接 kill:messages.json(模型上下文)只在轮次收尾落盘,强杀会丢掉
/// 执行中轮次的全部消息;而 UI 回放(events.jsonl)逐帧实时落盘看着完好,
/// 重启后用户发"继续"才发现模型没了上下文。
fn stop_kernel(mut child: Child) {
    drop(child.stdin.take());
    // 内核侧收尾预算:取消轮次等待 3s + HTTP 优雅关闭 3s,留足余量
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    eprintln!("[mc-desktop] 内核未在期限内优雅退出,强制终止");
    let _ = child.kill();
    let _ = child.wait();
}

// ==================== Tauri 命令(内核 UI 的设置视图调用) ====================

#[tauri::command]
fn get_config(app: AppHandle) -> DesktopConfig {
    load_config(&app)
}

/// 保存配置并(重)启内核,主窗口导航到新内核 URL(整页重载)。
/// 内容不做业务校验(壳零字段知识):表单校验在设置视图,权威校验在内核。
#[tauri::command]
fn save_config(app: AppHandle, config: DesktopConfig) -> Result<(), String> {
    let files = save_config_files(&app, &config)?;

    // 端口固定复用:必须先停旧内核释放端口,再起新内核(阻塞等就绪,最多 15 秒)。
    // 若新内核启动失败(仅安装级故障:二进制缺失等),设置视图内联展示错误,
    // 重试保存即可再次拉起。
    if let Some(old) = app.state::<Kernel>().0.lock().unwrap().take() {
        stop_kernel(old);
    }
    let (child, port, token) = start_kernel(&app, &files)?;
    app.state::<Kernel>().0.lock().unwrap().replace(child);
    let url = kernel_ui_url(port, &token);
    // 导航延后到本命令返回之后:WebKitGTK 会重放"页面导航走时响应尚未送达"
    // 的 IPC 请求(实测同一 invoke 二次进入本命令→内核被重启两次)。
    // 先让响应落地,再整页导航到新内核 URL。
    std::thread::spawn({
        let app = app.clone();
        move || {
            std::thread::sleep(Duration::from_millis(200));
            let _ = app.run_on_main_thread({
                let app = app.clone();
                move || show_kernel_ui(&app, &url)
            });
        }
    });
    Ok(())
}

/// 宿主信息(内核 UI 的设置视图"关于"卡片展示)。
#[tauri::command]
fn host_info(app: AppHandle) -> serde_json::Value {
    serde_json::json!({ "version": display_version(&app.package_info().version.to_string()) })
}

/// UI 内检查更新:返回结果而非弹对话框(设置视图内联展示)。
#[tauri::command]
async fn update_check(app: AppHandle) -> Result<serde_json::Value, String> {
    let updater = build_updater(&app)?;
    match updater.check().await {
        Ok(Some(u)) => Ok(serde_json::json!({
            "available": true,
            "current": display_version(&u.current_version),
            "latest": display_version(&u.version),
        })),
        Ok(None) => Ok(serde_json::json!({
            "available": false,
            "current": display_version(&app.package_info().version.to_string()),
        })),
        Err(e) => Err(format!("检查更新失败: {e}")),
    }
}

/// UI 内下载安装更新并重启(update_check 确认有新版后调用)。
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    let updater = build_updater(&app)?;
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return Err("当前已是最新版本".into()),
        Err(e) => return Err(format!("检查更新失败: {e}")),
    };
    eprintln!("[mc-desktop] 更新: UI 内触发下载安装 {}", update.version);
    update
        .download_and_install(|_, _| {}, || eprintln!("[mc-desktop] 更新: 下载完成,安装中"))
        .await
        .map_err(|e| format!("更新失败: {e}"))?;
    eprintln!("[mc-desktop] 更新: 安装完成,重启应用");
    app.restart();
}

// ==================== 自动更新 ====================
//
// OSS 静态清单(latest.json)+ tauri-plugin-updater:版本号与本地**不一致**
// 即提示(YYMMDDNN 日期序号占 semver 主版本位,"!=" 同时覆盖前进与回滚);
// 用户确认后下载安装并重启,minisign 签名校验完整性。

/// 展示用短版本号:去掉内部 semver 的 ".0.0" 后缀(26071401.0.0 → 26071401)。
fn display_version(v: &str) -> String {
    v.strip_suffix(".0.0").unwrap_or(v).to_string()
}

/// 更新流程中的提示(manual=托盘手动检查;自动检查失败只打日志不打扰)。
fn update_notice(app: &AppHandle, manual: bool, error: bool, msg: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    eprintln!("[mc-desktop] 更新: {msg}");
    if manual {
        let kind = if error { MessageDialogKind::Error } else { MessageDialogKind::Info };
        app.dialog().message(msg).title("检查更新").kind(kind).show(|_| {});
    }
}

/// 组装更新器(自动/手动/UI 内三条路径共用):不一致即有更新 + 清单地址可覆盖。
fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;
    let handle = app.clone();
    let mut builder = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        // 与 latest.json 的版本号不一致即视为有更新
        .version_comparator(|current, update| update.version != current)
        // Windows 安装器路径由插件直接退进程(不走 RunEvent::Exit),
        // 必须先在这里回收内核,否则 mc-agent.exe 占用文件导致 NSIS 安装失败
        .on_before_exit(move || {
            if let Some(child) = handle.state::<Kernel>().0.lock().unwrap().take() {
                stop_kernel(child);
            }
        });
    // 本机测试覆盖清单地址(release 构建强制 https,http 清单只在 debug 下可用)
    if let Ok(url) = std::env::var("MC_UPDATE_MANIFEST") {
        let u = url.parse().map_err(|e| format!("MC_UPDATE_MANIFEST 无效: {e}"))?;
        builder = builder.endpoints(vec![u]).map_err(|e| format!("更新地址无效: {e}"))?;
    }
    builder.build().map_err(|e| format!("初始化更新器失败: {e}"))
}

/// 检查更新并在有新版时询问用户;确认则下载安装 + 重启(内核经 RunEvent::Exit 回收)。
async fn check_update(app: AppHandle, manual: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    let updater = match build_updater(&app) {
        Ok(u) => u,
        Err(e) => return update_notice(&app, manual, true, &e),
    };

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            let cur = display_version(&app.package_info().version.to_string());
            return update_notice(&app, manual, false, &format!("当前已是最新版本({cur})"));
        }
        Err(e) => return update_notice(&app, manual, true, &format!("检查更新失败: {e}")),
    };

    let msg = format!(
        "发现新版本 {}(当前 {}),是否立即更新?\n更新完成后应用将自动重启。",
        display_version(&update.version),
        display_version(&update.current_version),
    );
    eprintln!("[mc-desktop] 更新: 发现新版本 {}(当前 {})", update.version, update.current_version);
    app.dialog()
        .message(msg)
        .title("发现新版本")
        .buttons(MessageDialogButtons::OkCancelCustom("立即更新".into(), "以后再说".into()))
        .show({
            let app = app.clone();
            move |confirmed| {
                if !confirmed {
                    return;
                }
                tauri::async_runtime::spawn(async move {
                    let mut announced = false;
                    let result = update
                        .download_and_install(
                            move |_chunk, total| {
                                if !announced {
                                    eprintln!("[mc-desktop] 更新: 开始下载({total:?} 字节)");
                                    announced = true;
                                }
                            },
                            || eprintln!("[mc-desktop] 更新: 下载完成,安装中"),
                        )
                        .await;
                    match result {
                        Ok(()) => {
                            eprintln!("[mc-desktop] 更新: 安装完成,重启应用");
                            app.restart();
                        }
                        // 用户已确认过更新,失败必须外显
                        Err(e) => update_notice(&app, true, true, &format!("更新失败: {e}")),
                    }
                });
            }
        });
}

// ==================== 窗口 ====================

/// 主窗口显示内核 UI(已存在则导航复用,否则创建)。
fn show_kernel_ui(app: &AppHandle, url: &str) {
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
        let opener = app.clone();
        let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
            .title("MonkeyCode")
            .inner_size(1200.0, 800.0)
            // 导航守卫:webview 只许待在内核 UI(loopback)与壳自带页面;
            // 其余导航(对话里的外部链接等)一律拒绝并交系统浏览器,
            // 防止应用被"跳走"后无法返回。UI 侧已拦截点击,这里是兜底。
            .on_navigation(move |url| {
                let internal = match url.scheme() {
                    "tauri" => true, // 壳自带页面(错误页)
                    "http" | "https" => {
                        matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "tauri.localhost"))
                    }
                    _ => false,
                };
                if !internal {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                }
                internal
            });
        // macOS:标题栏悬浮融入侧栏(红绿灯直接落在 UI 上),对齐新设计;
        // UI 侧在 mac 壳内为侧栏顶部预留拖拽区
        #[cfg(target_os = "macos")]
        {
            builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
        }
        // Windows:去原生装饰栏,UI 侧自绘 36px 标题栏(拖拽区 + 窗口按钮);
        // 错误页窗口不受影响(open_error_page 保留原生装饰,无自绘控件可用)
        #[cfg(target_os = "windows")]
        {
            builder = builder.decorations(false);
        }
        // 无头冒烟探针:页面加载后自动走一遍 远程页→IPC→壳配置 链路,
        // 结果经本地回环上报(无头环境唯一可靠的回读通道)
        if std::env::var("MC_DESKTOP_IPC_PROBE").is_ok() {
            builder = builder.initialization_script(
                "const report = (m) => fetch('http://127.0.0.1:18240/probe/' + encodeURIComponent(m), {mode:'no-cors'}).catch(()=>{}); \
                 report('script-injected:' + location.search + ':saved=' + (sessionStorage.getItem('mc-probe-saved') || '0')); \
                 setTimeout(() => { \
                   if (location.protocol !== 'http:') return; /* 仅在内核 UI 页触发 */ \
                   if (!window.__TAURI__ || !window.__TAURI__.core) { report('no-tauri'); return; } \
                   window.__TAURI__.core.invoke('get_config') \
                     .then((cfg) => { report('invoke-ok'); \
                       /* 保存→重启内核→整页重载 全链路:sessionStorage 跨重载存活, \
                          第二次加载报 reload-after-save-ok(仅片段变化的导航不会重载,此项会缺失) */ \
                       if (!sessionStorage.getItem('mc-probe-saved')) { \
                         sessionStorage.setItem('mc-probe-saved', '1'); \
                         window.__TAURI__.core.invoke('save_config', {config: cfg}) \
                           .then(() => report('save-ok')) \
                           .catch((e) => report('save-err:' + String(e).slice(0, 80))); \
                       } else { report('reload-after-save-ok'); } \
                     }) \
                     .catch((e) => report('invoke-err:' + String(e).slice(0, 80))); \
                   /* opener 全链路(命令 ACL + URL scope):无头环境以 BROWSER=/bin/true 承接 */ \
                   window.__TAURI__.core.invoke('plugin:opener|open_url', {url: 'https://nav-guard.invalid/from-opener'}) \
                     .then(() => report('opener-ok')) \
                     .catch((e) => report('opener-err:' + String(e).slice(0, 80))); \
                   /* 导航守卫:外域跳转应被拒;页面存活才能发出 1 秒后的上报 */ \
                   setTimeout(() => { location.href = 'https://nav-guard.invalid/x'; }, 1000); \
                   setTimeout(() => report('nav-guard-ok'), 2000); \
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Kernel(Mutex::new(None)))
        .manage(TrayReady(AtomicBool::new(true)))
        .manage(Tray(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            host_info,
            update_check,
            update_install
        ])
        .setup(|app| {
            // 托盘失败只降级(无托盘宿主的桌面环境),不阻塞
            if let Err(e) = setup_tray(app.handle()) {
                eprintln!("[mc-desktop] 托盘创建失败(关窗将直接退出): {e}");
                app.state::<TrayReady>().0.store(false, Ordering::Relaxed);
            }

            // 启动后延迟自检一次更新。debug 构建默认跳过(开发噪音),
            // 设置 MC_UPDATE_MANIFEST 时强制启用(本机 http 清单联调)。
            if !cfg!(debug_assertions) || std::env::var("MC_UPDATE_MANIFEST").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(5));
                    tauri::async_runtime::block_on(check_update(handle, false));
                });
            }

            // 无条件拉起内核:无配置时写出空清单,内核以零模型模式启动,
            // 首启向导由内核 UI 的设置视图承担(壳无业务页面)。
            let cfg = load_config(app.handle());
            let files = save_config_files(app.handle(), &cfg)?; // 刷新清单文件
            match start_kernel(app.handle(), &files) {
                Ok((child, port, token)) => {
                    eprintln!("[mc-desktop] 内核就绪: 127.0.0.1:{port}");
                    app.state::<Kernel>().0.lock().unwrap().replace(child);
                    show_kernel_ui(app.handle(), &kernel_ui_url(port, &token));
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
                if let Some(child) = app.state::<Kernel>().0.lock().unwrap().take() {
                    stop_kernel(child);
                }
            }
            _ => {}
        });
}

/// 创建托盘:菜单(显示窗口/设置/退出)+ 左键单击恢复窗口。
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 MonkeyCode", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &update, &quit])?;

    let tray = TrayIconBuilder::with_id("main")
        .icon(tray_icon_for(Theme::Light))
        .tooltip("MonkeyCode")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_any_window(app),
            // 设置视图在内核 UI 里:恢复窗口后发事件让 React 切到设置视图
            "settings" => {
                show_any_window(app);
                let _ = app.emit_to("main", "open-settings", ());
            }
            "check-update" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { check_update(app, true).await });
            }
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

/// 恢复主窗口(无条件拉内核后,主窗口=内核 UI 或错误页,总是存在)。
fn show_any_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

// ==================== 内核进程 ====================

/// 启动内核:配置经环境变量注入(不走 argv,避免泄漏进 ps)。
/// 返回 (子进程, 端口, 令牌)。
fn start_kernel(app: &AppHandle, files: &KernelFiles) -> Result<(Child, u16, String), String> {
    let bin = find_agent().ok_or_else(|| {
        "找不到 mc-agent 可执行文件(查找顺序: MC_AGENT_BIN 环境变量 → 应用同目录 → PATH)".to_string()
    })?;

    let port = kernel_port(app)?;
    let token = rand_token();

    let mut cmd = Command::new(&bin);
    cmd.args([
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
    .stderr(Stdio::inherit());
    // Windows 下内核是 console 程序,GUI 壳拉起时会弹出控制台窗口,须显式抑制
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
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

/// 内核端口:首次分配后持久化(配置目录 port 文件),之后复用。
/// localStorage 按 origin(协议+主机+端口)隔离,端口一变 UI 本地偏好
/// (主题/分组折叠等)就全部丢失;仅端口被其他进程占用时才换新并持久化。
fn kernel_port(app: &AppHandle) -> Result<u16, String> {
    let dir = config_dir(app)?;
    let path = dir.join("port");
    if let Some(p) = fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|&p| p != 0)
    {
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return Ok(p);
        }
        eprintln!("[mc-desktop] 端口 {p} 被占用,换用新端口(UI 本地偏好将重置)");
    }
    let p = free_port().map_err(|e| format!("无法分配本地端口: {e}"))?;
    let _ = fs::create_dir_all(&dir);
    if let Err(e) = fs::write(&path, p.to_string()) {
        eprintln!("[mc-desktop] 持久化端口失败(下次启动将换端口): {e}");
    }
    Ok(p)
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn rand_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("getrandom");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 内核 UI 入口 URL。boot 查询参数每次内核启动都不同:端口固定后,
/// 仅 #token 变化的导航是同文档导航,webview 不会重载页面(设置视图
/// 会永远停在"保存中");查询串变化才强制整页重载。token 走 fragment,
/// 不出现在 HTTP 请求行。
fn kernel_ui_url(port: u16, token: &str) -> String {
    let mut buf = [0u8; 4];
    getrandom::getrandom(&mut buf).expect("getrandom");
    let boot: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    format!("http://127.0.0.1:{port}/?boot={boot}#{token}")
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
