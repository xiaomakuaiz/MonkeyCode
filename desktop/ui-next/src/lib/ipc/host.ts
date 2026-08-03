// 宿主域 API:平台探测、窗口控制、壳信息。
// 所有 invoke 命令名保持字面量(契约守卫正则;plugin: 前缀的命令不进 ACL
// 对表,但 capability 已授权)。浏览器模式降级:探测返回 false、hostInfo
// 返回 null、窗控静默 no-op。
import { inDesktopShell, invoke } from "./ipc";

export function isMacShell(): boolean {
  return inDesktopShell() && /Mac/.test(navigator.userAgent);
}

export function isWindowsShell(): boolean {
  return inDesktopShell() && /Windows/.test(navigator.userAgent);
}

export type HostPlatform = "mac" | "windows" | "linux" | "browser";

export function hostPlatform(): HostPlatform {
  if (!inDesktopShell()) return "browser";
  if (isMacShell()) return "mac";
  if (isWindowsShell()) return "windows";
  return "linux";
}

/** 启动即调用:CSS/组件按 data-platform 做平台分支(mac 红绿灯让位等)。 */
export function applyPlatformAttr(): void {
  document.documentElement.dataset.platform = hostPlatform();
}

export interface HostInfo {
  version: string;
  engine_version: string | null;
}

export async function hostInfo(): Promise<HostInfo | null> {
  if (!inDesktopShell()) return null;
  try {
    return await invoke<HostInfo>("host_info");
  } catch {
    return null;
  }
}

/* ---- 窗口控制(不带 label 即作用于调用方窗口;close 由壳拦截转托盘) ---- */

const quiet = (p: Promise<unknown>): void => {
  void p.catch(() => {});
};

export function windowMinimize(): void {
  quiet(invoke("plugin:window|minimize"));
}

export function windowToggleMaximize(): void {
  quiet(invoke("plugin:window|toggle_maximize"));
}

export function windowClose(): void {
  quiet(invoke("plugin:window|close"));
}

export function windowIsMaximized(): Promise<boolean> {
  return invoke<boolean>("plugin:window|is_maximized").catch(() => false);
}

/** mac 绿灯默认行为:切换全屏(⌥ 点击才是最大化,由调用方分流)。 */
export async function windowToggleFullscreen(): Promise<void> {
  try {
    const fullscreen = await invoke<boolean>("plugin:window|is_fullscreen");
    await invoke("plugin:window|set_fullscreen", { value: !fullscreen });
  } catch {
    // 浏览器模式/命令失败:静默
  }
}

/** 窗口标题随视图变化;浏览器模式退回 document.title。 */
export function setWindowTitle(title: string): void {
  if (!inDesktopShell()) {
    document.title = title;
    return;
  }
  quiet(invoke("plugin:window|set_title", { title }));
}

/** 外链一律交系统浏览器:壳内 opener 失败时退回 location 导航(壳的
 *  on_navigation 守卫会拒绝并转系统浏览器);浏览器模式新开标签。
 *  只放行 http(s)——工作区文件链接由聊天层专门处理,不走这里。 */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (!inDesktopShell()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  void invoke("plugin:opener|open_url", { url }).catch(() => {
    location.href = url;
  });
}

/** 消费壳的待取意图("open-settings" / "open-session:<id>";无则 null)。
 *  壳在窗口唤起前就可能收到意图(托盘/桌宠),启动时取一次。 */
export function takeUiIntent(): Promise<string | null> {
  if (!inDesktopShell()) return Promise.resolve(null);
  return invoke<string | null>("take_ui_intent").catch(() => null);
}

/** 解析 "open-session:<id>" 意图;非字符串/非该前缀返回 null(壳返回值防御)。 */
export function sessionIdFromUiIntent(intent: unknown): string | null {
  if (typeof intent !== "string" || !intent.startsWith("open-session:")) return null;
  const id = intent.slice("open-session:".length);
  return id || null;
}

/** 打开引擎日志目录(文件管理器定位);浏览器模式 no-op。 */
export function openLogDir(): Promise<void> {
  if (!inDesktopShell()) return Promise.resolve();
  return invoke<string>("open_log_dir")
    .then(() => {})
    .catch(() => {});
}

/** WSL 模式下工作目录的家目录基座:guest 家目录的宿主视角
 *  (\\wsl$\<发行版>\home\<用户>;Linux 冒烟为 posix 家目录)。
 *  本机模式壳返回 None、浏览器模式/命令失败一律降级 null。 */
export async function wslWorkdirBase(): Promise<string | null> {
  if (!inDesktopShell()) return null;
  try {
    return (await invoke<string | null>("wsl_workdir_base")) ?? null;
  } catch {
    return null;
  }
}

/** 系统目录选择;取消/浏览器模式返回 null。 */
export async function pickDirectory(): Promise<string | null> {
  if (!inDesktopShell()) return null;
  try {
    const res = await invoke<string | string[] | null>("plugin:dialog|open", {
      options: { directory: true },
    });
    if (typeof res === "string") return res;
    if (Array.isArray(res)) return res[0] ?? null;
    return null;
  } catch {
    return null;
  }
}
