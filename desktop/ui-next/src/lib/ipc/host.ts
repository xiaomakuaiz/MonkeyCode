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
