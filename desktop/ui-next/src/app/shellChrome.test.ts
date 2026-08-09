import { describe, expect, it } from "vitest";

import { isDevtoolsHotkey } from "./shellChrome";

const key = (o: Partial<Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "shiftKey">>) => ({
  code: "",
  key: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...o,
});

describe("devtools 快捷键判定", () => {
  it("F12 与 ⌃⇧I 命中;普通 I/Ctrl+I 不命中", () => {
    expect(isDevtoolsHotkey(key({ key: "F12" }))).toBe(true);
    expect(isDevtoolsHotkey(key({ code: "KeyI", key: "I", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isDevtoolsHotkey(key({ code: "KeyI", key: "i", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isDevtoolsHotkey(key({ code: "KeyI", key: "I", ctrlKey: true }))).toBe(false);
    expect(isDevtoolsHotkey(key({ code: "KeyI", key: "I" }))).toBe(false);
  });

  it("mac 的 ⌘⇧I 同样命中(只判 ctrlKey 时 mac 用户打不开 devtools)", () => {
    expect(isDevtoolsHotkey(key({ code: "KeyI", key: "I", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isDevtoolsHotkey(key({ code: "KeyI", key: "I", metaKey: true }))).toBe(false);
  });

  it("认物理键位而非 key:输入法/非拉丁布局下 key 不是 I,仍要命中", () => {
    // 俄文布局按同一个物理键得到的是 "ш";按 key 判会整块失效
    expect(isDevtoolsHotkey(key({ code: "KeyI", key: "ш", ctrlKey: true, shiftKey: true }))).toBe(true);
    // 反向:别的物理键即使 key 恰好是 I 也不该命中
    expect(isDevtoolsHotkey(key({ code: "KeyJ", key: "I", ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});
