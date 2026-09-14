import { isMacShell } from "@/lib/ipc/host";

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

/** 壳入口统一安装，覆盖聊天、新建任务、搜索与设置中的文本框。 */
export function installMacosTextInputGuard(): () => void {
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
  window.addEventListener("keypress", onKeyPress, true);
  window.addEventListener("beforeinput", onBeforeInput, true);
  return () => {
    window.removeEventListener("keypress", onKeyPress, true);
    window.removeEventListener("beforeinput", onBeforeInput, true);
  };
}
