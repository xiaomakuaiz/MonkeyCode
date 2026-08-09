// 壳级 chrome 行为(main.tsx 启动时安装,浏览器模式不生效):
// - 右键:拦掉 WebView 原生菜单(带"检查元素/重新加载"且裁不掉),换自绘文本菜单
// - F12 / ⌃⇧I / ⌘⇧I:打开 devtools(壳命令)
import { openTextContextMenu } from "@/lib/contextMenu";
import { inDesktopShell, invoke } from "@/lib/ipc/ipc";

/** 判据两点(2026-08-09 对表旧工程补回):
 *  ① **mac 认 ⌘**——⌘⇧I 是 macOS 上 devtools 的标准手势,只判 ctrlKey 等于
 *     mac 用户根本打不开(壳内 devtools 未必有别的入口,排障就断在这);
 *  ② 用 `code` 而非 `key`——`key` 跟随键盘布局与输入法状态(俄/希腊/中文
 *     输入态下按同一个物理键得到的不是 "I"),`KeyI` 认的是物理键位。 */
export function isDevtoolsHotkey(e: Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "shiftKey">): boolean {
  if (e.key === "F12") return true;
  return (e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyI";
}

export function installShellChrome(): void {
  // 壳判定放进处理器而非注册时(旧工程同款):`window.__TAURI__` 由壳的初始化
  // 脚本注入,与本模块求值的先后不该被当成前提——注册时判一次,万一那次为假
  // 就是整个会话永远没有右键菜单和 devtools,且无从察觉
  window.addEventListener("contextmenu", (e) => {
    if (!inDesktopShell()) return;
    e.preventDefault();
    openTextContextMenu(e);
  });
  window.addEventListener("keydown", (e) => {
    if (!inDesktopShell()) return;
    if (!isDevtoolsHotkey(e)) return;
    e.preventDefault();
    void invoke("open_devtools").catch(() => {});
  });
}
