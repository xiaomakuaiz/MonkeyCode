import { describe, expect, it } from "vitest";

import { isDevtoolsHotkey } from "./shellChrome";

describe("devtools 快捷键判定", () => {
  it("F12 与 ⌃⇧I 命中;普通 I/Ctrl+I 不命中", () => {
    expect(isDevtoolsHotkey({ key: "F12", ctrlKey: false, shiftKey: false })).toBe(true);
    expect(isDevtoolsHotkey({ key: "I", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isDevtoolsHotkey({ key: "i", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isDevtoolsHotkey({ key: "I", ctrlKey: true, shiftKey: false })).toBe(false);
    expect(isDevtoolsHotkey({ key: "I", ctrlKey: false, shiftKey: false })).toBe(false);
  });
});
