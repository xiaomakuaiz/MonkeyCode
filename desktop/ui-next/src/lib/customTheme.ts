// 用户自定义主题(派生式)。
//
// 机制:daisyUI 5 的「主题」就是挂在 [data-theme="名"] 上的一组 CSS 自定义
// 属性,别无其他(见 node_modules/daisyui/theme/*.css:一套主题 = color-scheme
// + 20 个颜色变量 + 8 个几何/质感变量)。所以自定义主题不需要 daisyUI 提供
// 任何运行时 API——注入一段 CSS 就是一套主题。
//
// 为什么是「派生」而不是「快照」:本模块只产出用户改动的那几个变量,挂在
// [data-mc-custom] 上,与基础主题的 [data-theme=<base>] **叠加**生效,其余
// 十几个变量继续由基础主题提供。
// - 快照法(getComputedStyle 读全 28 个变量再写死)会在 daisyUI 升级新增变量
//   时留下缺项,且每次都要探测 DOM;派生法天然跟随上游。
// - 能叠加的依据:daisyUI 的主题声明落在 @layer base 内(产物 CSS 中主题块的
//   偏移小于 @layer utilities 的起点),而本模块的样式是运行时注入的**无层**
//   规则——按 CSS 层叠规则无层胜过任何层,不必靠提高选择器特异性去压。
//
// 纯函数、不碰 DOM/localStorage:落地与注入在 lib/theme.ts,单测可直接导入。
// **不 import theme.ts**:那边要 import 本模块,反向再引就成环。基础主题名的
// 合法性由调用方以 isBase 谓词传入(theme.ts 手里才有 THEMES)。

/** 自定义主题在 mc.theme 里的取值(非 daisyUI 主题名,不进 THEMES 清单)。 */
export const CUSTOM_THEME = "mc-custom";

/** 承载覆盖变量的属性:与 data-theme 同挂一个元素,叠加生效。 */
export const CUSTOM_ATTR = "data-mc-custom";

/** 注入的 <style> 元素 id(首帧脚本与运行时共用,避免重复插入)。 */
export const CUSTOM_STYLE_ID = "mc-custom-theme";

export interface CustomTheme {
  /** 基础主题:未被覆盖的变量全部由它提供 */
  base: string;
  /** 主色(#rgb / #rrggbb) */
  primary: string;
  /** 底色 = --color-base-100 */
  base100: string;
  /** --radius-box / --radius-field,单位 rem */
  radius: number;
  /** --border,单位 px */
  border: number;
}

export const RADIUS_RANGE = { min: 0, max: 2, step: 0.125 } as const;
export const BORDER_RANGE = { min: 0, max: 4, step: 1 } as const;

export const DEFAULT_CUSTOM: CustomTheme = {
  base: "monkeycode",
  primary: "#16a34a",
  base100: "#fcfdfc",
  radius: 1,
  border: 1,
};

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** #rgb → #rrggbb;已是 6 位则只做小写归一。非法值返回 null。 */
export function normalizeHex(hex: string): string | null {
  if (!HEX_RE.test(hex)) return null;
  const h = hex.toLowerCase();
  if (h.length === 7) return h;
  return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
}

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 相对亮度(0=黑 1=白);非法色按中灰处理,不抛。 */
export function luminance(hex: string): number {
  const h = normalizeHex(hex);
  if (!h) return 0.5;
  const r = Number.parseInt(h.slice(1, 3), 16);
  const g = Number.parseInt(h.slice(3, 5), 16);
  const b = Number.parseInt(h.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 与白/黑对比度相等的亮度交点:L 使 (1.05)/(L+.05) == (L+.05)/.05。
 * 取这个阈值意味着"选中的那一侧永远是对比度更高的一侧",不是随手拍的 0.5。 */
const CROSSOVER = Math.sqrt(1.05 * 0.05) - 0.05; // ≈0.1791

const ON_LIGHT = "#101010";
const ON_DARK = "#ffffff";

/** 压在该底色上仍可读的前景色(黑白二选一,取对比度更高的一侧)。 */
export function readableOn(hex: string): string {
  return luminance(hex) > CROSSOVER ? ON_LIGHT : ON_DARK;
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** 覆盖变量表(唯一真值源:注入用的 CSS 与设置页色板的内联 style 都从这里出,
 * 两处各写一份派生规则迟早漂)。键即 CSS 属性名,`--` 开头的是自定义属性。 */
export function customThemeVars(c: CustomTheme): Record<string, string> {
  const primary = normalizeHex(c.primary) ?? DEFAULT_CUSTOM.primary;
  const base100 = normalizeHex(c.base100) ?? DEFAULT_CUSTOM.base100;
  const onBase = readableOn(base100);
  const radius = clamp(c.radius, RADIUS_RANGE.min, RADIUS_RANGE.max);
  const border = clamp(c.border, BORDER_RANGE.min, BORDER_RANGE.max);
  return {
    // color-scheme 决定原生滚动条/表单控件的深浅,必须跟着底色走,否则深色
    // 自定义主题下会冒出一条白色原生滚动条
    "color-scheme": luminance(base100) > CROSSOVER ? "light" : "dark",
    "--color-base-100": base100,
    "--color-base-content": onBase,
    // 200/300 朝 base-content 掺色,而不是写死"变深":浅色主题里 base-content
    // 是深的 → 掺出更深的面;深色主题里是浅的 → 掺出更浅的面。一条式子两头都对
    "--color-base-200": `color-mix(in oklab,${base100} 95%,${onBase})`,
    "--color-base-300": `color-mix(in oklab,${base100} 88%,${onBase})`,
    "--color-primary": primary,
    "--color-primary-content": readableOn(primary),
    // 只动 box/field 两档;--radius-selector 留给基础主题——它管复选框/开关
    // 这类小控件,跟着大圆角走会直接变成圆饼
    "--radius-box": `${radius}rem`,
    "--radius-field": `${radius}rem`,
    "--border": `${border}px`,
  };
}

/** 生成注入用的 CSS 文本(单条规则,已压紧;调用方原样塞进 <style>)。 */
export function customThemeCss(c: CustomTheme): string {
  const body = Object.entries(customThemeVars(c))
    .map(([k, v]) => `${k}:${v};`)
    .join("");
  return `[${CUSTOM_ATTR}]{${body}}`;
}

/** localStorage 里的脏数据一律矫正回合法值;完全解析不了才返回 null。
 * isBase:基础主题名是否合法(卸载过的主题名要回落,否则 data-theme 落一个
 * 没有声明的值,daisyUI 回落缺省主题,用户的覆盖色叠在一套没预料的底上)。 */
export function parseCustomTheme(raw: string | null, isBase: (v: string) => boolean): CustomTheme | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Partial<Record<keyof CustomTheme, unknown>>;
  const base = typeof o.base === "string" && isBase(o.base) ? o.base : DEFAULT_CUSTOM.base;
  const primary = (typeof o.primary === "string" ? normalizeHex(o.primary) : null) ?? DEFAULT_CUSTOM.primary;
  const base100 = (typeof o.base100 === "string" ? normalizeHex(o.base100) : null) ?? DEFAULT_CUSTOM.base100;
  const radius = typeof o.radius === "number" && Number.isFinite(o.radius) ? clamp(o.radius, RADIUS_RANGE.min, RADIUS_RANGE.max) : DEFAULT_CUSTOM.radius;
  const border = typeof o.border === "number" && Number.isFinite(o.border) ? clamp(o.border, BORDER_RANGE.min, BORDER_RANGE.max) : DEFAULT_CUSTOM.border;
  return { base, primary, base100, radius, border };
}
