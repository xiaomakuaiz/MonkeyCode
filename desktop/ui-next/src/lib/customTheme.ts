// 用户自定义主题:从一个种子色**生成整套调色板**,不是"改几个变量"。
//
// 上一版只覆盖 primary/base-100 两项、base-content 取纯黑白、其余留给基础
// 主题——结果是中性色全无色相、secondary/accent 还是旧主题的颜色,跟新主色
// 不搭(用户报障:「太丑,还不如官方随机生成的」)。对照 daisyUI 内置主题就
// 能看出差在哪:它们的中性色**是带主色相的**,base-content 也不是黑,
//   valentine  base-100 oklch(97% 0.014 343) / base-content oklch(52% 0.223 3)
//   dracula    base-100 oklch(28.8% 0.022 277) / secondary 比 primary 少 45 度
//   nord       整套压在 H≈250 附近,靠彩度高低拉开层次
// 共同规律:同一色相家族 + 感知亮度阶梯 + 彩度按角色分档。本模块照这个规律
// 生成,所以随手一个随机色相也不会难看。
//
// 与官方 theme-generator 的取舍(https://daisyui.com/theme-generator/):
// 官方逐个色都给拾色器(base/primary/secondary/accent/neutral + 四个语义色)、
// 圆角分 box/field/selector 三档、另有 size/depth/noise。这里按「派生式·少量
// 关键项」定案只留种子色 + 明暗 + 圆角 + 边框,其余全部自动算——官方那套的
// 自由度是给做主题的人用的,这里的用户只想要"换个颜色还得好看"。
// content 色自动算这一条与官方一致。
//
// 纯函数、不碰 DOM/localStorage:落地与注入在 lib/theme.ts,单测可直接导入。
import { hexToOklch, normalizeHex, oklchCss, oklchToHex, type Oklch } from "./oklch";

/** 自定义主题在 mc.theme 里的取值(非 daisyUI 主题名,不进 THEMES 清单)。 */
export const CUSTOM_THEME = "mc-custom";

/** 承载生成变量的属性:与 data-theme 同挂一个元素,叠加生效。 */
export const CUSTOM_ATTR = "data-mc-custom";

/** 注入的 <style> 元素 id(首帧脚本与运行时共用,避免重复插入)。 */
export const CUSTOM_STYLE_ID = "mc-custom-theme";

export interface CustomTheme {
  /** 明暗:决定亮度阶梯的方向,也是兜底 data-theme 的取值 */
  mode: "light" | "dark";
  /** 种子色(#rrggbb):整套配色的色相与彩度都由它推 */
  seed: string;
  /** --radius-box / --radius-field,单位 rem */
  radius: number;
  /** --border,单位 px */
  border: number;
}

export const RADIUS_RANGE = { min: 0, max: 2, step: 0.125 } as const;
export const BORDER_RANGE = { min: 0, max: 4, step: 1 } as const;

export const DEFAULT_CUSTOM: CustomTheme = {
  mode: "light",
  seed: "#16a34a",
  radius: 1,
  border: 1,
};

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const rotate = (h: number, deg: number): number => (((h + deg) % 360) + 360) % 360;

/** 各角色的亮度/彩度配方。数值是对着上面那几套内置主题量出来的档位,
 * 不是随手取的:改这里等于改"生成的主题长什么样"。 */
const RECIPE = {
  light: {
    base100: { l: 0.98, cMul: 0.08, cMax: 0.012 },
    base200: { l: 0.95, cMul: 0.12, cMax: 0.02 },
    base300: { l: 0.9, cMul: 0.18, cMax: 0.03 },
    baseContent: { l: 0.28, cMul: 0.35, cMax: 0.06 },
    neutral: { l: 0.32, cMul: 0.12, cMax: 0.025 },
    /** 主色亮度收进这个窗口:太亮的种子色当按钮底会看不清白字,太暗则闷 */
    brand: { min: 0.55, max: 0.76 },
    semantic: 0.7,
  },
  dark: {
    base100: { l: 0.24, cMul: 0.12, cMax: 0.022 },
    base200: { l: 0.28, cMul: 0.14, cMax: 0.026 },
    base300: { l: 0.33, cMul: 0.16, cMax: 0.03 },
    baseContent: { l: 0.93, cMul: 0.12, cMax: 0.022 },
    neutral: { l: 0.4, cMul: 0.14, cMax: 0.03 },
    brand: { min: 0.62, max: 0.82 },
    semantic: 0.74,
  },
} as const;

/** 语义色固定色相:它们要先是"红黄绿蓝"才谈得上配色,不能跟着种子转,
 * 否则错误提示会变成一坨跟主色同色的东西。彩度跟着种子走一点,不至于像
 * 贴上去的。 */
const SEMANTIC_HUE = { info: 225, success: 155, warning: 80, error: 26 } as const;

/** 亮度高于此值的面用深色前景,否则用浅色前景(OKLCH 的 L 是感知亮度,
 * 这条阈值在所有色相上都成立——这正是不在 hex 上做的原因)。 */
const CONTENT_SPLIT = 0.62;

/** 压在某个颜色上的前景色:同色相的极深/极浅色,不是纯黑纯白——纯色前景
 * 在带色相的底上会显得脏,内置主题也都用同家族的深浅两端。 */
function contentOn({ l, c, h }: Oklch): Oklch {
  return l >= CONTENT_SPLIT ? { l: 0.2, c: Math.min(c * 0.3, 0.05), h } : { l: 0.98, c: Math.min(c * 0.1, 0.02), h };
}

const surface = (spec: { l: number; cMul: number; cMax: number }, seed: Oklch): Oklch => ({
  l: spec.l,
  c: Math.min(seed.c * spec.cMul, spec.cMax),
  h: seed.h,
});

/** 生成整套调色板(20 个颜色变量)。 */
export function palette(seedHex: string, mode: "light" | "dark"): Record<string, string> {
  const seed = hexToOklch(seedHex) ?? hexToOklch(DEFAULT_CUSTOM.seed)!;
  const r = RECIPE[mode];
  // 种子彩度太低(用户挑了灰)时给个下限,否则整套主题灰成一片没有性格
  const c = Math.max(seed.c, 0.06);
  const brandL = clamp(seed.l, r.brand.min, r.brand.max);

  const primary: Oklch = { l: brandL, c, h: seed.h };
  // −55°/+115°:内置主题里 secondary 普遍是主色相的近邻(dracula 差 45、
  // valentine 差 50),accent 拉开到另一侧做点缀
  const secondary: Oklch = { l: brandL, c: c * 0.95, h: rotate(seed.h, -55) };
  const accent: Oklch = { l: clamp(brandL + 0.04, 0, 1), c: c * 0.85, h: rotate(seed.h, 115) };
  const neutral = surface(r.neutral, { ...seed, c });

  const sem = (hue: number, chroma: number): Oklch => ({ l: r.semantic, c: chroma, h: hue });
  const info = sem(SEMANTIC_HUE.info, 0.13);
  const success = sem(SEMANTIC_HUE.success, 0.14);
  const warning = sem(SEMANTIC_HUE.warning, 0.15);
  const error = sem(SEMANTIC_HUE.error, 0.18);

  const pair = (name: string, color: Oklch): Record<string, string> => ({
    [`--color-${name}`]: oklchCss(color),
    [`--color-${name}-content`]: oklchCss(contentOn(color)),
  });

  const base100 = surface(r.base100, { ...seed, c });
  return {
    "--color-base-100": oklchCss(base100),
    "--color-base-200": oklchCss(surface(r.base200, { ...seed, c })),
    "--color-base-300": oklchCss(surface(r.base300, { ...seed, c })),
    "--color-base-content": oklchCss(surface(r.baseContent, { ...seed, c })),
    ...pair("primary", primary),
    ...pair("secondary", secondary),
    ...pair("accent", accent),
    ...pair("neutral", neutral),
    ...pair("info", info),
    ...pair("success", success),
    ...pair("warning", warning),
    ...pair("error", error),
  };
}

/** 覆盖变量表(唯一真值源:注入用的 CSS 与设置页预览的内联 style 都从这里出)。 */
export function customThemeVars(c: CustomTheme): Record<string, string> {
  const radius = clamp(c.radius, RADIUS_RANGE.min, RADIUS_RANGE.max);
  const border = clamp(c.border, BORDER_RANGE.min, BORDER_RANGE.max);
  return {
    // 跟着明暗走,否则深色主题下会冒出一条白色原生滚动条
    "color-scheme": c.mode,
    ...palette(c.seed, c.mode),
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

/** 随机种子色:随机的是**色相**,亮度/彩度锁在好看的窗口里——这正是官方
 * randomize 出来的东西总不难看的原因(乱掷 RGB 必然出泥色)。 */
export function randomSeed(rand: () => number = Math.random): string {
  return oklchToHex({ l: 0.62, c: 0.15 + rand() * 0.09, h: rand() * 360 });
}

/** localStorage 里的脏数据一律矫正回合法值;完全解析不了才返回 null。 */
export function parseCustomTheme(raw: string | null): CustomTheme | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Partial<Record<keyof CustomTheme, unknown>>;
  const mode = o.mode === "dark" ? "dark" : "light";
  const seed = (typeof o.seed === "string" ? normalizeHex(o.seed) : null) ?? DEFAULT_CUSTOM.seed;
  const radius =
    typeof o.radius === "number" && Number.isFinite(o.radius) ? clamp(o.radius, RADIUS_RANGE.min, RADIUS_RANGE.max) : DEFAULT_CUSTOM.radius;
  const border =
    typeof o.border === "number" && Number.isFinite(o.border) ? clamp(o.border, BORDER_RANGE.min, BORDER_RANGE.max) : DEFAULT_CUSTOM.border;
  return { mode, seed, radius, border };
}
