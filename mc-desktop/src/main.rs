// MonkeyCode 本地桌面客户端 —— Tauri 壳。
//
// 职责边界:壳持有**应用配置**(模型列表等)与宿主事务(进程生命周期、
// 托盘、桌宠、更新),并承载 UI(ui/ 构建产物随壳分发,frontendDist)。
// 引擎 ohmyagent 是壳拉起的子进程(stdio JSON-RPC,driver/ohmy.rs),
// UI 只经 Tauri IPC 与壳对话。
//
// 生命周期:
//   启动 → 拉起引擎(无配置则零模型模式)→ 主窗口加载内置 UI。
//   设置保存 → 壳物化配置 → 重启引擎 → UI 整页刷新(会话在磁盘,重连自动回放)。
//   关主窗口只隐藏(任务继续跑),托盘"退出"才真正退出并回收引擎。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod baizhi;
mod browser;
mod config;
mod driver;
mod repo;
mod uploads;
mod wsl;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Theme, WebviewUrl, WebviewWindowBuilder, WindowEvent};
#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, StyleMask, WebviewWindowExt as _};

use config::{load_config, save_config_files, DesktopConfig};
use driver::DriverHost;

// macOS 桌宠面板类:普通 NSWindow 被点击会激活应用——主窗口被系统提到
// 最前并拿到焦点,触发"main 聚焦→藏桌宠",表现为"一点猴子主窗口就弹出、
// 猴子消失"。NonactivatingPanel 点击不激活应用,彻底断根。
// hides_on_deactivate 必须关:NSPanel 默认应用失活即隐藏,而桌宠恰恰在
// 应用失活时出场,不关的话面板刚 show 就被系统藏掉。
#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(PetPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true,
            hides_on_deactivate: false
        }
    })
}

// ==================== 状态 ====================

/// 托盘是否可用;不可用时关窗直接退出(否则窗口藏起来就找不回了)。
struct TrayReady(AtomicBool);

/// 托盘句柄(系统明暗主题切换时换图标)。
struct Tray(Mutex<Option<TrayIcon>>);

/// 壳→UI 的待处理意图(如托盘"设置")。事件是发后不管的:webview 未就绪
/// 时监听器不存在,事件静默丢失。意图同时落在这里,UI 启动完成后经
/// take_ui_intent 取走补处理,两路兜底。
struct UiIntent(Mutex<Option<String>>);

/// 桌宠开关的运行时缓存(焦点切换高频读,不每次读盘;真值落 config.json)。
struct PetEnabled(AtomicBool);

/// 桌宠位置暂存:Moved 事件在拖动中高频触发,不能逐次写盘;
/// 退出与托盘开关切换时经 persist_pet_prefs 落盘。
struct PetPos(Mutex<Option<(i32, i32)>>);

/// 托盘图标:macOS 用模板剪影(黑 + alpha,紧裁占满菜单栏高度;配合
/// icon_as_template 由系统按菜单栏明暗自动反色),其余平台用彩色透明图形。
fn tray_icon_for(_theme: Theme) -> Image<'static> {
    #[cfg(target_os = "macos")]
    return Image::from_bytes(include_bytes!("../icons/tray-mac.png")).expect("托盘图标解码失败");
    #[cfg(not(target_os = "macos"))]
    Image::from_bytes(include_bytes!("../icons/tray.png")).expect("托盘图标解码失败")
}

/// 主题变化时更新托盘图标(仅非 macOS)。
/// macOS 必须跳过:模板图标由系统按菜单栏明暗自动反色,无需换图;
/// 且 tray-icon 0.24.1 的 set_icon 会把模板标记硬编码重置为 false,
/// 一旦换图,黑色剪影在深色菜单栏按字面渲染 = 图标"消失"。
fn sync_tray_theme(app: &AppHandle, theme: Theme) {
    #[cfg(target_os = "macos")]
    let _ = (app, theme);
    #[cfg(not(target_os = "macos"))]
    if let Some(tray) = app.state::<Tray>().0.lock().unwrap().as_ref() {
        let _ = tray.set_icon(Some(tray_icon_for(theme)));
    }
}

// ==================== Tauri 命令(UI 调用) ====================

#[tauri::command]
fn get_config(app: AppHandle) -> DesktopConfig {
    load_config(&app)
}

/// 在文件管理器中定位随包分发的浏览器扩展目录(设置页引导用户到
/// chrome://extensions「加载已解压的扩展程序」选它)。返回目录路径。
/// dev 运行(cargo run 无 bundle 资源)回退仓库内 browser-extension/dist。
#[tauri::command]
fn open_extension_dir(app: AppHandle) -> Result<String, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app
        .path()
        .resolve("browser-extension", tauri::path::BaseDirectory::Resource)
    {
        candidates.push(p);
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../browser-extension/dist"));
    let dir = candidates
        .into_iter()
        .find(|p| p.join("manifest.json").is_file())
        .ok_or_else(|| "扩展目录不存在(安装包未包含扩展,或开发环境未构建 browser-extension)".to_string())?;
    tauri_plugin_opener::reveal_item_in_dir(&dir).map_err(|e| format!("打开目录失败: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 写清单并(重)启引擎(阻塞流程:优雅停内核 ~10s + 起新内核 ~15s,
/// 调用方负责丢 blocking 池)。save_config 与 engine_restart 共用。
fn apply_config_and_restart(app: &AppHandle, config: &DesktopConfig) -> Result<(), String> {
    save_config_files(app, config)?;
    if let Some(engine) = app.state::<DriverHost>().take() {
        engine.stop();
    }
    let engine = driver::start_engine(app, config)?;
    app.state::<DriverHost>().set(engine);
    Ok(())
}

/// 保存配置并重启引擎。内容不做业务校验(壳零字段知识):表单校验在设置
/// 视图,权威校验在内核。返回后 UI 自行整页刷新(不再有壳侧导航,原
/// WebKitGTK IPC 重放竞态随之消失)。
#[tauri::command]
async fn save_config(app: AppHandle, config: DesktopConfig) -> Result<(), String> {
    // 设置视图载荷只含业务字段,壳自有偏好(桌宠)从磁盘合并保留
    let disk = load_config(&app);
    let config = DesktopConfig {
        pet_enabled: disk.pet_enabled,
        pet_pos: disk.pet_pos,
        ..config
    };
    tauri::async_runtime::spawn_blocking(move || apply_config_and_restart(&app, &config))
        .await
        .map_err(|e| format!("保存失败: {e}"))?
}

/// 按当前配置重启引擎(引擎崩溃后 UI 一键恢复;engine-crashed 事件的出口)。
#[tauri::command]
async fn engine_restart(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = load_config(&app);
        apply_config_and_restart(&app, &config)
    })
    .await
    .map_err(|e| format!("重启失败: {e}"))?
}

/// 取走(消费)待处理的壳→UI 意图。UI 两处调用:启动完成后补处理错过的
/// 事件;open-settings 事件处理器里消费掉副本,防止下次整页加载时重放。
#[tauri::command]
fn take_ui_intent(app: AppHandle) -> Option<String> {
    app.state::<UiIntent>().0.lock().unwrap().take()
}

/// 宿主信息(设置视图"关于"卡片展示)。
#[tauri::command]
fn host_info(app: AppHandle) -> serde_json::Value {
    serde_json::json!({ "version": display_version(&app.package_info().version.to_string()) })
}

/// 无头探针的备用上报通道(仅 MC_DESKTOP_IPC_PROBE 下注册使用):
/// fetch 通道依赖 WebKit 网络进程,其崩溃时经 IPC 落 stderr 仍可观测。
#[tauri::command]
fn probe_log(msg: String) {
    eprintln!("[probe] {msg}");
}

/// 唤回主窗口(桌宠点击)。
#[tauri::command]
fn show_main(app: AppHandle) {
    show_any_window(&app);
}

/// 枚举 WSL 发行版(设置视图"运行环境"下拉用)。
/// 非 Windows、未装 WSL 或任何失败均返回空数组,UI 据此隐藏 WSL 选项。
#[tauri::command]
fn list_wsl_distros() -> Vec<String> {
    wsl::list_distros()
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
        // 必须先在这里回收引擎进程,否则 ohmyagent.exe 占用文件导致 NSIS 安装失败
        .on_before_exit(move || {
            if let Some(engine) = handle.state::<DriverHost>().take() {
                engine.stop();
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

/// 允许 webview 停留的内部地址:壳内置页面(app://tauri 协议)。
/// 其余导航(对话里的外部链接等)一律拒绝并交系统浏览器。
fn is_internal_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        // Windows 下 Tauri app 页面以 http(s)://tauri.localhost 承载
        "http" | "https" => matches!(url.host_str(), Some("tauri.localhost")),
        _ => false,
    }
}

/// 创建主窗口并加载壳内置页面(page 如 "index.html" / "error.html#msg")。
fn create_main_window(app: &AppHandle, page: &str) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let opener = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(page.into()))
        .title("MonkeyCode")
        .inner_size(1200.0, 800.0)
        // 布局下限:设置视图(168px 导航 + 内容列 + 保存条)在极窄窗口下
        // 保存按钮会被挤出可视区
        .min_inner_size(640.0, 480.0)
        // Tauri 默认的原生拖放处理器会在窗口层吞掉文件拖拽,HTML5 的
        // drag/drop 事件到不了页面(对话区拖入图片/文件依赖 DOM 事件);
        // 禁用后由 UI 侧统一处理
        .disable_drag_drop_handler()
        // 导航守卫:webview 只许待在壳内置页面;外部链接交系统浏览器,
        // 防止应用被"跳走"后无法返回。UI 侧已拦截点击,这里是兜底。
        .on_navigation(move |url| {
            let internal = is_internal_url(url);
            if !internal {
                use tauri_plugin_opener::OpenerExt;
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            internal
        });
    // macOS:标题栏悬浮融入侧栏(红绿灯直接落在 UI 上);
    // UI 侧在 mac 壳内为侧栏顶部预留拖拽区
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    // Windows:去原生装饰栏,UI 侧自绘 36px 标题栏(拖拽区 + 窗口按钮)
    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false);
    }
    // 无头冒烟探针:页面加载后自动走一遍 UI→IPC→壳配置 链路,
    // 结果经本地回环上报(无头环境唯一可靠的回读通道)
    if std::env::var("MC_DESKTOP_IPC_PROBE").is_ok() {
        builder = builder.initialization_script(
            "const report = (m) => { fetch('http://127.0.0.1:18240/probe/' + encodeURIComponent(m), {mode:'no-cors'}).catch(()=>{}); \
               try { window.__TAURI__ && window.__TAURI__.core.invoke('probe_log', {msg: m}).catch(()=>{}); } catch {} }; \
             let hb = 0; setInterval(() => report('hb-' + (++hb)), 2000); \
             window.addEventListener('error', (e) => report('jserr:' + String(e.message).slice(0, 120))); \
             window.addEventListener('unhandledrejection', (e) => report('rej:' + String(e.reason).slice(0, 120))); \
             report('script-injected:' + location.search + ':saved=' + (sessionStorage.getItem('mc-probe-saved') || '0')); \
             setTimeout(() => { \
               if (!window.__TAURI__ || !window.__TAURI__.core) { report('no-tauri'); return; } \
               window.__TAURI__.core.invoke('get_config') \
                 .then((cfg) => { report('invoke-ok'); \
                   /* 保存→重启引擎 链路:save_config 返回即成功(UI 自行 reload)。 \
                      延后到其他探针都完成之后(引擎重启期间 IPC 不可用) */ \
                   if (!sessionStorage.getItem('mc-probe-saved')) { \
                     sessionStorage.setItem('mc-probe-saved', '1'); \
                     setTimeout(() => { \
                       window.__TAURI__.core.invoke('save_config', {config: cfg}) \
                         .then(() => report('save-ok')) \
                         .catch((e) => report('save-err:' + String(e).slice(0, 80))); \
                     }, 12000); \
                   } \
                 }) \
                 .catch((e) => report('invoke-err:' + String(e).slice(0, 80))); \
               window.__TAURI__.core.invoke('take_ui_intent') \
                 .then(() => report('take-intent-ok')) \
                 .catch((e) => report('take-intent-err:' + String(e).slice(0, 80))); \
               window.__TAURI__.event.listen('mc-probe-evt', () => {}) \
                 .then(() => report('listen-ok')) \
                 .catch((e) => report('listen-err:' + String(e).slice(0, 80))); \
               window.__TAURI__.core.invoke('plugin:opener|open_url', {url: 'https://nav-guard.invalid/from-opener'}) \
                 .then(() => report('opener-ok')) \
                 .catch((e) => report('opener-err:' + String(e).slice(0, 80))); \
               /* 导航守卫探测放最后:引擎重启(save)耗时数秒,且取消中的 \
                  在途导航在 WebKitGTK 有副作用,不能与其他探针交叠 */ \
               setTimeout(() => { location.href = 'https://nav-guard.invalid/x'; }, 20000); \
               setTimeout(() => report('nav-guard-ok'), 21000); \
             }, 3000);",
        );
    }
    let _ = builder.build();
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(theme) = win.theme() {
            sync_tray_theme(app, theme);
        }
    }
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

// ==================== 桌宠 ====================

/// 桌宠窗口尺寸(逻辑像素):气泡(24)+ 吉祥物精灵图(88)的画布。
const PET_W: f64 = 116.0;
const PET_H: f64 = 120.0;

/// 创建桌宠窗口(初始隐藏,主窗口失焦/隐藏时显示)。
/// focusable(false):桌宠是状态外显不是交互主体,永不抢焦点;
/// 鼠标点击与拖动不依赖键盘焦点,不受影响。
fn ensure_pet_window(app: &AppHandle) {
    if app.get_webview_window("pet").is_some() {
        return;
    }
    let saved = load_config(app).pet_pos;
    let win = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
        .title("MonkeyCode 桌宠")
        .inner_size(PET_W, PET_H)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focusable(false)
        .focused(false)
        .visible(false)
        .build();
    match win {
        Ok(win) => {
            let _ = win.set_position(pet_position(app, saved));
            // macOS:转 NonactivatingPanel(见文件头 PetPanel 注释);
            // 无边框样式保持与 decorations(false) 一致
            #[cfg(target_os = "macos")]
            match win.to_panel::<PetPanel>() {
                Ok(panel) => {
                    panel.set_style_mask(StyleMask::empty().borderless().nonactivating_panel().into());
                }
                Err(e) => eprintln!("[mc-desktop] 桌宠转 NSPanel 失败(点击会激活应用): {e}"),
            }
        }
        Err(e) => eprintln!("[mc-desktop] 桌宠窗口创建失败: {e}"),
    }
}

/// 桌宠位置:记忆位置仍落在任一显示器内则沿用(显示器可能被拔掉),
/// 否则回主显示器右下角留边(避开任务栏)。
fn pet_position(app: &AppHandle, saved: Option<(i32, i32)>) -> tauri::PhysicalPosition<i32> {
    if let Some((x, y)) = saved {
        let on_screen = app.available_monitors().unwrap_or_default().iter().any(|m| {
            let p = m.position();
            let s = m.size();
            x >= p.x && x < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32
        });
        if on_screen {
            return tauri::PhysicalPosition::new(x, y);
        }
    }
    let (mx, my, mw, mh, scale) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32, m.scale_factor())
        })
        .unwrap_or((0, 0, 1280, 800, 1.0));
    let w = (PET_W * scale) as i32;
    let h = (PET_H * scale) as i32;
    let margin = (24.0 * scale) as i32;
    let taskbar = (56.0 * scale) as i32;
    tauri::PhysicalPosition::new(mx + mw - w - margin, my + mh - h - margin - taskbar)
}

/// 按条件显示/隐藏桌宠:显示要求 开关开 && 引擎在跑(引擎没起时
/// 桌宠只会展示"离线",徒增噪音);隐藏无条件执行。
fn set_pet_visible(app: &AppHandle, show: bool) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    if !show {
        let _ = pet.hide();
        return;
    }
    let enabled = app.state::<PetEnabled>().0.load(Ordering::Relaxed);
    let engine_running = app.state::<DriverHost>().running();
    if enabled && engine_running {
        let _ = pet.show();
    }
}

/// 桌宠偏好落盘:以磁盘配置为基础只覆写壳自有字段,只写权威 config.json
/// (不触发引擎配置物化——含密钥的 ~/.ohmyagent 不该被无关操作反复重写)。
fn persist_pet_prefs(app: &AppHandle) {
    let mut cfg = load_config(app);
    cfg.pet_enabled = app.state::<PetEnabled>().0.load(Ordering::Relaxed);
    if let Some(pos) = *app.state::<PetPos>().0.lock().unwrap() {
        cfg.pet_pos = Some(pos);
    }
    if let Err(e) = config::save_config_json(app, &cfg) {
        eprintln!("[mc-desktop] 桌宠偏好保存失败: {e}");
    }
}

fn main() {
    eprintln!("[mc-desktop] main 进入");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    // 桌宠 NSPanel 转换(ensure_pet_window)依赖此插件注册的面板管理状态
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .manage(DriverHost::new())
        .manage(TrayReady(AtomicBool::new(true)))
        .manage(Tray(Mutex::new(None)))
        .manage(UiIntent(Mutex::new(None)))
        .manage(PetEnabled(AtomicBool::new(true)))
        .manage(PetPos(Mutex::new(None)))
        .manage(baizhi::monkeycode::CloudPipes::new())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            take_ui_intent,
            host_info,
            show_main,
            update_check,
            update_install,
            open_extension_dir,
            list_wsl_distros,
            engine_restart,
            probe_log,
            driver::engine_caps,
            browser::browser_status,
            browser::browser_repair,
            driver::sessions_list,
            driver::session_create,
            driver::session_delete,
            driver::session_patch,
            driver::models_list,
            driver::session_open,
            driver::session_close,
            driver::session_send,
            driver::session_call,
            driver::upload_file,
            driver::upload_read,
            baizhi::baizhi_status,
            baizhi::baizhi_send_code,
            baizhi::baizhi_login,
            baizhi::baizhi_logout,
            baizhi::baizhi_wechat_start,
            baizhi::baizhi_wechat_poll,
            baizhi::baizhi_sync,
            baizhi::mc_status,
            baizhi::mc_login,
            baizhi::mc_logout,
            baizhi::mc_tasks,
            baizhi::mc_task_info,
            baizhi::mc_task_rounds,
            baizhi::mc_task_stop,
            baizhi::mc_task_create,
            baizhi::mc_task_options,
            baizhi::monkeycode::cloud_ws_open,
            baizhi::monkeycode::cloud_ws_send,
            baizhi::monkeycode::cloud_ws_close
        ])
        .setup(|app| {
            // 百智云/云端服务(壳级单例;凭证 cookie 与配置同目录)
            let cfg_dir = config::config_dir(app.handle()).map_err(std::io::Error::other)?;
            app.manage(baizhi::BaizhiState(std::sync::Arc::new(baizhi::Service::new(cfg_dir))));

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

            // 无条件拉起引擎:无配置时写出空配置,引擎以零模型模式启动,
            // 首启向导由 UI 的设置视图承担(壳无业务页面)。
            let cfg = load_config(app.handle());
            app.state::<PetEnabled>().0.store(cfg.pet_enabled, Ordering::Relaxed);
            // 浏览器桥 + MCP server 先于引擎:配置物化要写入 MCP URL/token
            browser::init(app.handle());
            save_config_files(app.handle(), &cfg)?; // 刷新物化配置
            match driver::start_engine(app.handle(), &cfg) {
                Ok(engine) => {
                    app.state::<DriverHost>().set(engine);
                    create_main_window(app.handle(), "index.html");
                    ensure_pet_window(app.handle());
                }
                Err(e) => {
                    eprintln!("[mc-desktop] 引擎启动失败: {e}");
                    create_main_window(app.handle(), &format!("error.html#{}", urlencode(&e)));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::ThemeChanged(theme) = event {
                sync_tray_theme(window.app_handle(), *theme);
            }
            // 主窗口前台与否 = 桌宠退场/接棒:在前台看得见状态,桌宠隐藏;
            // 失焦(切去别的应用)则桌宠出场外显任务状态
            if let WindowEvent::Focused(focused) = event {
                if window.label() == "main" {
                    set_pet_visible(window.app_handle(), !*focused);
                }
            }
            // 桌宠拖动:位置暂存,退出/开关切换时落盘(Moved 高频,不逐次写)
            if let WindowEvent::Moved(pos) = event {
                if window.label() == "pet" {
                    window
                        .app_handle()
                        .state::<PetPos>()
                        .0
                        .lock()
                        .unwrap()
                        .replace((pos.x, pos.y));
                }
            }
            // 主窗口:引擎在跑且托盘可用时关窗只隐藏;错误页正常关闭
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let app = window.app_handle();
                let engine_running = app.state::<DriverHost>().running();
                let tray_ready = app.state::<TrayReady>().0.load(Ordering::Relaxed);
                if engine_running && tray_ready {
                    let _ = window.hide();
                    api.prevent_close();
                    // hide 不保证在所有平台补发 Focused(false),显式接棒
                    set_pet_visible(app, true);
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
                persist_pet_prefs(app); // 拖动位置只在退出/开关切换时落盘
                if let Some(engine) = app.state::<DriverHost>().take() {
                    engine.stop();
                }
            }
            _ => {}
        });
}

/// 创建托盘:菜单(显示窗口/设置/退出)+ 左键单击恢复窗口。
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let pet = CheckMenuItem::with_id(app, "toggle-pet", "显示桌宠", true, load_config(app).pet_enabled, None::<&str>)?;
    let update = MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 MonkeyCode", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &pet, &update, &quit])?;
    let tray = TrayIconBuilder::new()
        .icon(tray_icon_for(Theme::Light))
        // macOS 模板渲染(系统按菜单栏明暗反色);其余平台此标记为空操作
        .icon_as_template(true)
        .tooltip("MonkeyCode")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_any_window(app),
            // 设置在 UI 页内:恢复主窗口后发事件让 React 切到设置视图;
            // 意图同时落待取状态,webview 未就绪丢事件时由 UI 启动后补取
            "settings" => {
                show_any_window(app);
                app.state::<UiIntent>().0.lock().unwrap().replace("open-settings".into());
                let _ = app.emit_to("main", "open-settings", ());
            }
            // 桌宠开关:CheckMenuItem 点击自翻勾选态,这里同步运行时缓存并落盘;
            // 开启时仅在主窗口不在前台才立即出场(在前台本就该藏)
            "toggle-pet" => {
                let enabled = !app.state::<PetEnabled>().0.load(Ordering::Relaxed);
                app.state::<PetEnabled>().0.store(enabled, Ordering::Relaxed);
                persist_pet_prefs(app);
                let main_focused = app
                    .get_webview_window("main")
                    .and_then(|w| w.is_focused().ok())
                    .unwrap_or(false);
                set_pet_visible(app, enabled && !main_focused);
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

/// 恢复主窗口。
fn show_any_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
