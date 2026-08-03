// 壳级 chrome 行为(main.tsx 启动时安装,浏览器模式不装):
// - 右键:拦掉 WebView 原生菜单(带"检查元素/重新加载"且裁不掉),换自绘文本菜单
// - F12 / ⌃⇧I:打开 devtools(壳命令)
import { openTextContextMenu } from "@/lib/contextMenu";
import { inDesktopShell, invoke } from "@/lib/ipc/ipc";

export function isDevtoolsHotkey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey">): boolean {
  return e.key === "F12" || (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "i"));
}

export function installShellChrome(): void {
  if (!inDesktopShell()) return;
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openTextContextMenu(e);
  });
  window.addEventListener("keydown", (e) => {
    if (isDevtoolsHotkey(e)) {
      e.preventDefault();
      void invoke("open_devtools").catch(() => {});
    }
  });
}
