import { describe, expect, it } from "vitest";

import {
  customThemeCss,
  customThemeVars,
  luminance,
  normalizeHex,
  parseCustomTheme,
  readableOn,
  CUSTOM_ATTR,
  DEFAULT_CUSTOM,
} from "./customTheme";

const isBase = (v: string) => v === "monkeycode" || v === "valentine";

describe("normalizeHex", () => {
  it("#rgb 展开成 #rrggbb,大小写归一", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#16A34A")).toBe("#16a34a");
  });

  it("非法值给 null(不抛,调用方回落默认)", () => {
    expect(normalizeHex("16a34a")).toBeNull(); // 缺 #
    expect(normalizeHex("#12345")).toBeNull(); // 位数不对
    expect(normalizeHex("rgb(1,2,3)")).toBeNull();
    expect(normalizeHex("")).toBeNull();
  });
});

describe("readableOn(前景色按对比度二选一)", () => {
  it("浅底给深字、深底给白字", () => {
    expect(readableOn("#ffffff")).toBe("#101010");
    expect(readableOn("#000000")).toBe("#ffffff");
  });

  it("选中的那一侧对比度确实更高(阈值取的是黑白等对比交点,不是拍脑袋的 0.5)", () => {
    // 中蓝:亮度低于交点 → 该给白字
    const mid = "#2563eb";
    const L = luminance(mid);
    const vsWhite = 1.05 / (L + 0.05);
    const vsBlack = (L + 0.05) / 0.05;
    expect(readableOn(mid)).toBe(vsWhite >= vsBlack ? "#ffffff" : "#101010");
    // 亮黄:亮度高于交点 → 该给深字
    const bright = "#fde047";
    const L2 = luminance(bright);
    expect(readableOn(bright)).toBe(1.05 / (L2 + 0.05) >= (L2 + 0.05) / 0.05 ? "#ffffff" : "#101010");
    expect(readableOn(bright)).toBe("#101010");
  });
});

describe("customThemeVars(派生规则)", () => {
  it("只产出覆盖项:颜色 4 项 + 面色阶 2 项 + 圆角 2 项 + 边框 + color-scheme", () => {
    const vars = customThemeVars(DEFAULT_CUSTOM);
    expect(Object.keys(vars).sort()).toEqual(
      [
        "--border",
        "--color-base-100",
        "--color-base-200",
        "--color-base-300",
        "--color-base-content",
        "--color-primary",
        "--color-primary-content",
        "--radius-box",
        "--radius-field",
        "color-scheme",
      ].sort(),
    );
    // --radius-selector 不在其中:它管复选框/开关,跟着大圆角走会变圆饼
    expect(vars["--radius-selector"]).toBeUndefined();
  });

  it("base-200/300 朝 base-content 掺色 → 浅底掺出更深的面、深底掺出更浅的面", () => {
    const light = customThemeVars({ ...DEFAULT_CUSTOM, base100: "#ffffff" });
    expect(light["--color-base-content"]).toBe("#101010");
    expect(light["--color-base-200"]).toContain("#101010"); // 掺的是深色
    const dark = customThemeVars({ ...DEFAULT_CUSTOM, base100: "#101828" });
    expect(dark["--color-base-content"]).toBe("#ffffff");
    expect(dark["--color-base-200"]).toContain("#ffffff"); // 同一条式子,掺的是浅色
  });

  it("color-scheme 跟着底色走(深色底不能留浅色原生滚动条)", () => {
    expect(customThemeVars({ ...DEFAULT_CUSTOM, base100: "#ffffff" })["color-scheme"]).toBe("light");
    expect(customThemeVars({ ...DEFAULT_CUSTOM, base100: "#101828" })["color-scheme"]).toBe("dark");
  });

  it("越界的圆角/边框收进量程,非法色回落默认(脏配置不能产出坏 CSS)", () => {
    const vars = customThemeVars({ base: "x", primary: "not-a-color", base100: "#fff", radius: 99, border: -5 });
    expect(vars["--radius-box"]).toBe("2rem"); // RADIUS_RANGE.max
    expect(vars["--border"]).toBe("0px"); // BORDER_RANGE.min
    expect(vars["--color-primary"]).toBe(DEFAULT_CUSTOM.primary);
  });
});

describe("customThemeCss", () => {
  it("单条规则挂在 CUSTOM_ATTR 上(与基础主题的 data-theme 叠加,不是取代)", () => {
    const css = customThemeCss(DEFAULT_CUSTOM);
    expect(css.startsWith(`[${CUSTOM_ATTR}]{`)).toBe(true);
    expect(css.endsWith("}")).toBe(true);
    // 不得出现 data-theme 选择器:基础主题那套变量要留给它自己提供
    expect(css).not.toContain("data-theme");
    expect(css).toContain(`--color-primary:${DEFAULT_CUSTOM.primary};`);
  });
});

describe("parseCustomTheme(脏数据矫正)", () => {
  it("完整合法配置原样返回", () => {
    const cfg = { base: "valentine", primary: "#ff0000", base100: "#000000", radius: 0.5, border: 2 };
    expect(parseCustomTheme(JSON.stringify(cfg), isBase)).toEqual(cfg);
  });

  it("空/坏 JSON 给 null(调用方据此判定「没配过」)", () => {
    expect(parseCustomTheme(null, isBase)).toBeNull();
    expect(parseCustomTheme("", isBase)).toBeNull();
    expect(parseCustomTheme("{不是 json", isBase)).toBeNull();
    expect(parseCustomTheme("123", isBase)).toBeNull();
  });

  it("卸载过的基础主题名回落默认:落一个没有声明的 data-theme,覆盖色会叠在意料之外的底上", () => {
    const cfg = parseCustomTheme(JSON.stringify({ ...DEFAULT_CUSTOM, base: "已删除的主题" }), isBase);
    expect(cfg?.base).toBe(DEFAULT_CUSTOM.base);
  });

  it("缺字段/类型不对逐项回落,不整份丢弃", () => {
    const cfg = parseCustomTheme(JSON.stringify({ base: "valentine", radius: "大" }), isBase);
    expect(cfg).toEqual({ ...DEFAULT_CUSTOM, base: "valentine" });
  });
});
