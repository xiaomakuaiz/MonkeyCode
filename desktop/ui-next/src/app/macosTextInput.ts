import { isMacShell, pasteInMacosWebview } from "@/lib/ipc/host";

// AppKit 用 U+F700–U+F747 表示方向键/Home/End/F1 等功能键。
// 为 macOS 15.7.5 的方向键变方块报告兜住 WKWebView 将功能键当作文本
// 插入的路径。只阻止错误的文本插入，不取消 keydown：光标移动、Shift
// 选区和组件的方向键菜单仍由原生编辑器/组件处理。
// 范围定义：https://www.unicode.org/Public/MAPPINGS/VENDORS/APPLE/CORPCHAR.TXT
function isFunctionKeyText(text: string | null): boolean {
  return text !== null && /^[\uF700-\uF747]$/.test(text);
}

function isEditable(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return !target.readOnly && !target.disabled;
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

function editCommand(event: KeyboardEvent): "copy" | "cut" | "paste" | "selectAll" | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const commands = { KeyC: "copy", KeyX: "cut", KeyV: "paste", KeyA: "selectAll" } as const;
  const command = commands[event.code as keyof typeof commands];
  if (!command) return null;
  const target = event.target;
  // xterm 的复制/粘贴由终端自己的按键与 ClipboardEvent 处理器负责。
  if (!(target instanceof HTMLElement) || target.closest(".xterm")) return null;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (target.disabled) return null;
    if (target.readOnly && (command === "cut" || command === "paste")) return null;
    if (target instanceof HTMLInputElement) {
      if (!/^(text|password|search|url|tel|email)$/.test(target.type)) return null;
      if (target.type === "password" && (command === "copy" || command === "cut")) return null;
    }
    return command;
  }
  if (target.isContentEditable) return command;
  return command === "copy" && window.getSelection()?.toString() ? command : null;
}

/** 壳入口统一安装，覆盖聊天、新建任务、搜索与设置中的文本框。 */
export function installMacosTextInputGuard(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isMacShell() || event.defaultPrevented || event.isComposing) return;
    const command = editCommand(event);
    if (!command) return;
    if (command === "paste") {
      event.preventDefault();
      const focused = document.activeElement;
      void pasteInMacosWebview().catch(() => {
        // 兼容旧壳/原生调用失败；焦点变化后不能误粘到另一个输入框。
        if (focused === document.activeElement) document.execCommand("paste");
      });
    } else if (document.execCommand(command)) {
      // 在真实按键手势里同步执行，保留选区和剪切的撤销栈。成功后取消
      // 默认动作，避免系统快捷键再剪切/复制一次；失败则交回原生菜单。
      event.preventDefault();
    }
  };
  const onKeyPress = (event: KeyboardEvent) => {
    if (!isMacShell() || !isEditable(event.target) || event.isComposing) return;
    // WKWebView 的 key 可能仍是 ArrowLeft，实际文本在 charCode 中。
    if (isFunctionKeyText(event.key) || isFunctionKeyText(String.fromCharCode(event.charCode))) {
      event.preventDefault();
    }
  };
  const onBeforeInput = (event: InputEvent) => {
    if (!isMacShell() || !isEditable(event.target) || event.isComposing) return;
    // 覆盖不派发 keypress 的插入路径；粘贴、组合输入与其他私用区字符放行。
    if (event.inputType === "insertText" && isFunctionKeyText(event.data)) {
      event.preventDefault();
    }
  };
  // bubble 阶段尊重组件先行处理，不抢输入法/终端等局部快捷键。
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keypress", onKeyPress, true);
  window.addEventListener("beforeinput", onBeforeInput, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keypress", onKeyPress, true);
    window.removeEventListener("beforeinput", onBeforeInput, true);
  };
}
