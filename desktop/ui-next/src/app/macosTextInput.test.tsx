import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMacosTextInputGuard } from "./macosTextInput";

const arrows = [
  ["ArrowUp", "\uF700"],
  ["ArrowDown", "\uF701"],
  ["ArrowLeft", "\uF702"],
  ["ArrowRight", "\uF703"],
] as const;

function TextField({ multiline = false }: { multiline?: boolean }) {
  const [value, setValue] = useState("");
  const props = { "aria-label": "输入", value, onChange: (e: { target: { value: string } }) => setValue(e.target.value) };
  return multiline ? <textarea {...props} /> : <input {...props} />;
}

function beforeInput(target: HTMLElement, data: string | null, inputType = "insertText", isComposing = false) {
  const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, data, inputType, isComposing });
  target.dispatchEvent(event);
  return event;
}

let uninstall: () => void;
let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
  invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  uninstall = installMacosTextInputGuard();
});

describe("macOS 文本编辑快捷键", () => {
  function mockEditing() {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    return execCommand;
  }

  it.each([false, true])("⌘C/X/A 在当前选区执行一次，⌘V 走原生粘贴（multiline=%s）", (multiline) => {
    const execCommand = mockEditing();
    render(<TextField multiline={multiline} />);
    const box = screen.getByRole("textbox") as HTMLInputElement | HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "汉字 abc123" } });
    box.focus();
    box.setSelectionRange(0, 2);
    for (const [code, command] of [["KeyC", "copy"], ["KeyX", "cut"], ["KeyA", "selectAll"]]) {
      expect(fireEvent.keyDown(box, { code, metaKey: true })).toBe(false);
      expect(execCommand).toHaveBeenLastCalledWith(command);
      expect(document.activeElement).toBe(box);
    }
    expect(fireEvent.keyDown(box, { code: "KeyV", metaKey: true })).toBe(false);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("macos_paste", undefined);
    expect(execCommand).toHaveBeenCalledTimes(3);
  });

  it("不抢已被组件消费的按键、输入法组合、附加修饰键或终端按键", () => {
    const execCommand = mockEditing();
    render(<><TextField /><div className="xterm"><textarea aria-label="终端" /></div></>);
    const box = screen.getByRole("textbox", { name: "输入" });
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) {
      expect(fireEvent.keyDown(box, { code: "KeyV", metaKey: true, ...extra })).toBe(true);
    }
    expect(fireEvent.keyDown(box, { code: "KeyV", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(screen.getByRole("textbox", { name: "终端" }), { code: "KeyV", metaKey: true })).toBe(true);
    const consumed = new KeyboardEvent("keydown", { code: "KeyV", metaKey: true, bubbles: true, cancelable: true });
    consumed.preventDefault();
    box.dispatchEvent(consumed);
    expect(execCommand).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("只读框可复制但不能剪切或粘贴，密码框不复制，按钮不截获粘贴", () => {
    const execCommand = mockEditing();
    render(<><textarea readOnly aria-label="只读" /><input type="password" aria-label="密码" /><input disabled aria-label="禁用" /><button>按钮</button></>);
    const readonly = screen.getByRole("textbox", { name: "只读" });
    expect(fireEvent.keyDown(readonly, { code: "KeyC", metaKey: true })).toBe(false);
    for (const code of ["KeyX", "KeyV"]) expect(fireEvent.keyDown(readonly, { code, metaKey: true })).toBe(true);
    for (const code of ["KeyC", "KeyX"]) expect(fireEvent.keyDown(screen.getByLabelText("密码"), { code, metaKey: true })).toBe(true);
    for (const target of [screen.getByRole("button"), screen.getByLabelText("禁用")]) {
      expect(fireEvent.keyDown(target, { code: "KeyV", metaKey: true })).toBe(true);
    }
    expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("同步编辑失败时保留系统默认处理；原生粘贴失败时只在原焦点兜底", async () => {
    const execCommand = mockEditing();
    execCommand.mockReturnValue(false);
    invoke.mockRejectedValue(new Error("native paste unavailable"));
    render(<TextField />);
    const box = screen.getByRole("textbox");
    box.focus();
    expect(fireEvent.keyDown(box, { code: "KeyC", metaKey: true })).toBe(true);
    fireEvent.keyDown(box, { code: "KeyV", metaKey: true });
    await Promise.resolve();
    expect(execCommand).toHaveBeenLastCalledWith("paste");
    execCommand.mockClear();
    fireEvent.keyDown(box, { code: "KeyV", metaKey: true });
    box.blur();
    await Promise.resolve();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it.each(["browser", "windows", "linux"])("%s 的复制粘贴仍由平台处理", (platform) => {
    const execCommand = mockEditing();
    if (platform === "browser") vi.stubGlobal("__TAURI__", undefined);
    else vi.spyOn(navigator, "userAgent", "get").mockReturnValue(platform === "windows" ? "Windows NT 10.0" : "X11; Linux x86_64");
    render(<TextField />);
    for (const code of ["KeyC", "KeyX", "KeyV", "KeyA"]) {
      expect(fireEvent.keyDown(screen.getByRole("textbox"), { code, metaKey: true })).toBe(true);
    }
    expect(execCommand).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  uninstall();
  Reflect.deleteProperty(document, "execCommand"); // jsdom 本身不实现此编辑 API
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("macOS 功能键文本兼容", () => {
  it.each([false, true])("文字/数字后按方向键不会追加方块（multiline=%s）", (multiline) => {
    render(<TextField multiline={multiline} />);
    const box = screen.getByRole("textbox") as HTMLInputElement | HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "汉字 abc123" } });
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);

    for (const [key, text] of [...arrows, ...arrows]) {
      expect(fireEvent.keyDown(box, { key })).toBe(true);
      const press = new KeyboardEvent("keypress", { key, charCode: text.charCodeAt(0), bubbles: true, cancelable: true });
      box.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      // jsdom 没有原生编辑器：模拟 WebKit 在事件未被取消时的默认插入。
      if (!press.defaultPrevented && !beforeInput(box, text).defaultPrevented) {
        fireEvent.input(box, { target: { value: box.value + text } });
      }
      fireEvent.keyUp(box, { key });
    }
    expect(box.value).toBe("汉字 abc123");
  });

  it.each(arrows)("没有 keypress 时仍阻止 %s 的特殊字符写入", (_key, text) => {
    render(<TextField multiline />);
    const box = screen.getByRole("textbox");
    expect(beforeInput(box, text).defaultPrevented).toBe(true);
  });

  it("功能键字符出现在 key 中时同样拦截", () => {
    render(<TextField />);
    expect(fireEvent.keyPress(screen.getByRole("textbox"), { key: "\uF702", charCode: 0 })).toBe(false);
  });

  it("光标移动后仍能在正确位置输入和替换文字", async () => {
    const user = userEvent.setup();
    render(<TextField multiline />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.type(box, "汉字123");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(box.selectionStart).toBe(3);
    expect(box.selectionEnd).toBe(3);
    await user.keyboard("9");
    expect(box.value).toBe("汉字1923");
    box.setSelectionRange(3, 5);
    await user.keyboard("9");
    expect(box.value).toBe("汉字193");
  });

  it("方向键与 Shift/Option/Command 组合的导航事件原样传给输入框", () => {
    render(<TextField multiline />);
    const box = screen.getByRole("textbox");
    const onKeyDown = vi.fn();
    box.addEventListener("keydown", onKeyDown);
    // user-event 的 moveSelection 尚不支持 Shift 选区；这里验证导航事件
    // 未被取消或截断，真实选区移动需在 WKWebView 中验收。
    for (const [key] of arrows) {
      for (const modifiers of [{}, { shiftKey: true }, { altKey: true }, { metaKey: true }, { metaKey: true, shiftKey: true }]) {
        expect(fireEvent.keyDown(box, { key, ...modifiers })).toBe(true);
        expect(fireEvent.keyPress(box, { key, charCode: 0, ...modifiers })).toBe(true);
        expect(fireEvent.keyUp(box, { key, ...modifiers })).toBe(true);
      }
    }
    expect(onKeyDown).toHaveBeenCalledTimes(20);
  });

  it("只处理可编辑目标，不干预只读框、禁用框和非文本控件", () => {
    render(<><textarea readOnly /><input disabled /><button>按钮</button></>);
    for (const target of [...screen.getAllByRole("textbox"), screen.getByRole("button")]) {
      expect(fireEvent.keyPress(target, { key: "ArrowLeft", charCode: 0xF702 })).toBe(true);
      expect(beforeInput(target, "\uF702").defaultPrevented).toBe(false);
    }
  });

  it("不拦截中文组合输入、粘贴、换行或其他私用区字符", () => {
    render(<TextField multiline />);
    const box = screen.getByRole("textbox");
    for (const text of ["汉字", "123", "a", "😀", "\uE000", "\uF8FF"]) {
      expect(beforeInput(box, text).defaultPrevented).toBe(false);
    }
    expect(beforeInput(box, "中文", "insertCompositionText", true).defaultPrevented).toBe(false);
    expect(beforeInput(box, "\uF702", "insertText", true).defaultPrevented).toBe(false);
    expect(fireEvent.keyPress(box, { key: "\uF702", charCode: 0xF702, isComposing: true })).toBe(true);
    expect(beforeInput(box, "粘贴\uF702", "insertFromPaste").defaultPrevented).toBe(false);
    expect(beforeInput(box, "\uF702", "insertFromPaste").defaultPrevented).toBe(false);
    expect(beforeInput(box, null, "insertLineBreak").defaultPrevented).toBe(false);
    expect(beforeInput(box, null, "deleteContentBackward").defaultPrevented).toBe(false);
  });

  it.each(["browser", "windows", "linux"])("%s 环境不启用兼容处理", (platform) => {
    if (platform === "browser") vi.stubGlobal("__TAURI__", undefined);
    else vi.spyOn(navigator, "userAgent", "get").mockReturnValue(platform === "windows" ? "Windows NT 10.0" : "X11; Linux x86_64");
    render(<TextField />);
    const box = screen.getByRole("textbox");
    expect(fireEvent.keyPress(box, { key: "ArrowLeft", charCode: 0xF702 })).toBe(true);
    expect(beforeInput(box, "\uF702").defaultPrevented).toBe(false);
  });

  it("安装时尚未注入 Tauri，后续事件仍可受保护；卸载后恢复原行为", () => {
    uninstall();
    vi.stubGlobal("__TAURI__", undefined);
    uninstall = installMacosTextInputGuard();
    vi.stubGlobal("__TAURI__", { core: { invoke: vi.fn() } });
    render(<TextField />);
    const box = screen.getByRole("textbox");
    expect(beforeInput(box, "\uF702").defaultPrevented).toBe(true);
    uninstall();
    expect(beforeInput(box, "\uF702").defaultPrevented).toBe(false);
    expect(fireEvent.keyPress(box, { key: "ArrowLeft", charCode: 0xF702 })).toBe(true);
  });
});
