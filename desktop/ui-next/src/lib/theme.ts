// 主题偏好:daisyUI 内置 35 主题全量可选,根节点 data-theme 选主题。
// localStorage 键 mc.theme 与旧工程同名(旧值 "dark" 天然合法,无缝继承);
// mc.themeBg 缓存当前主题的 base-100 色值,index.html 首帧脚本用它防闪
// (35 套主题不可能像 light/dark 那样把底色写死进 <style>)。
// 模块顶层不碰 localStorage、只用 getItem/setItem(node 单测可导入)。

const THEME_KEY = "mc.theme";
const THEME_BG_KEY = "mc.themeBg";

/** 与 styles/app.css 的 @plugin daisyui themes 清单一致(有测试对表)。 */
export const THEMES = [
  "light", "dark", "abyss", "acid", "aqua", "autumn", "black", "bumblebee",
  "business", "caramellatte", "cmyk", "coffee", "corporate", "cupcake",
  "cyberpunk", "dim", "dracula", "emerald", "fantasy", "forest", "garden",
  "halloween", "lemonade", "lofi", "luxury", "night", "nord", "pastel",
  "retro", "silk", "sunset", "synthwave", "valentine", "winter", "wireframe",
] as const;

export type Theme = (typeof THEMES)[number];

function isTheme(value: string | null): value is Theme {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

/** 只认清单内的值:缺失/脏数据/存储不可读一律回落浅色。 */
export function readTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return isTheme(raw) ? raw : "light";
  } catch {
    return "light";
  }
}

// 落属性后缓存该主题的 base-100(供下次启动的首帧防闪)。取不到(样式未载入/
// node 测试)就跳过——防闪缓存是增强项,不能反过来挡主题切换。
const applyTheme = (theme: Theme): void => {
  document.documentElement.dataset.theme = theme;
  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--color-base-100").trim();
    if (bg) localStorage.setItem(THEME_BG_KEY, bg);
  } catch {
    // 无 CSS 引擎或存储不可写:跳过缓存
  }
};

/** 写盘并立即生效;写盘失败仍应用本次主题,避免点击无反馈。 */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // WebView 存储不可写时只丢失持久化,不影响本次会话的观感。
  }
  applyTheme(theme);
}

/** 启动即调用(render 之前):首帧兜底与 index.html 脚本互为冗余,
 *  并把脏值(卸载过的主题名)矫正回清单内。 */
export function applyStoredTheme(): void {
  applyTheme(readTheme());
}
