import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyStoredTheme, readTheme, setTheme, THEMES } from "./theme";

// unit(node)环境无 DOM/存储:只桩出用到的全局
let values: Map<string, string>;
let root: { dataset: { theme?: string }; style: { background?: string } };

beforeEach(() => {
  values = new Map<string, string>();
  root = { dataset: {}, style: {} };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("document", { documentElement: root });
});

afterEach(() => vi.unstubAllGlobals());

describe("主题偏好", () => {
  it("缺省、清单外脏数据和不可读存储都回落品牌主题", () => {
    expect(readTheme()).toBe("monkeycode");
    values.set("mc.theme", "dark");
    expect(readTheme()).toBe("dark");
    values.set("mc.theme", "dracula");
    expect(readTheme()).toBe("dracula");
    values.set("mc.theme", "midnight"); // 不在清单
    expect(readTheme()).toBe("monkeycode");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: vi.fn(),
    });
    expect(readTheme()).toBe("monkeycode");
  });

  it("切换写盘并显式落根节点属性", () => {
    setTheme("synthwave");
    expect(values.get("mc.theme")).toBe("synthwave");
    expect(root.dataset.theme).toBe("synthwave");
    setTheme("light");
    expect(root.dataset.theme).toBe("light");
  });

  it("换主题后缓存 base-100 供首帧防闪;无 CSS 引擎时静默跳过", () => {
    // node 环境无 getComputedStyle:不抛、不写缓存
    setTheme("nord");
    expect(values.has("mc.themeBg")).toBe(false);

    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: (name: string) => (name === "--color-base-100" ? " oklch(95.127% 0.007 260.731) " : ""),
    }));
    setTheme("nord");
    expect(values.get("mc.themeBg")).toBe("oklch(95.127% 0.007 260.731)");
  });

  it("启动矫正脏值并落属性;存储不可写时仍应用本次主题", () => {
    values.set("mc.theme", "已卸载的主题");
    applyStoredTheme();
    expect(root.dataset.theme).toBe("monkeycode");

    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    expect(() => setTheme("dark")).not.toThrow();
    expect(root.dataset.theme).toBe("dark");
  });
});

describe("THEMES 清单与 app.css 对表", () => {
  it("内置 themes 列表 + 自定义主题块 name 与 THEMES 完全一致", () => {
    const css = readFileSync(fileURLToPath(new URL("../styles/app.css", import.meta.url)), "utf-8");
    const block = /@plugin "daisyui"\s*\{([^}]*)\}/.exec(css);
    expect(block, "app.css 缺 @plugin daisyui 块").toBeTruthy();
    const builtin = (/themes:\s*([^;]+);/.exec(block?.[1] ?? "")?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().split(/\s+/)[0] ?? "")
      .filter(Boolean);
    const custom = [...css.matchAll(/@plugin "daisyui\/theme"\s*\{[^}]*?name:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect([...custom, ...builtin].sort()).toEqual([...THEMES].sort());
  });
});
