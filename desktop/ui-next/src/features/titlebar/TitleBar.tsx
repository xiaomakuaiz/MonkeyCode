// 自绘窗口 chrome:
// - Windows 壳去掉原生装饰栏,这里补 36px 标题栏(左侧按 rail/side 列宽分段
//   与内容区对齐,右侧最小化/最大化(还原)/关闭三键,关闭键 hover 官方红)。
// - mac 壳隐藏原生红绿灯(TitleBarStyle::Overlay),MacWindowControls 自绘
//   10px 圆点(悬停整组浮现字形、窗口失焦整组退灰;绿点 ⌥ 点击最大化、
//   否则全屏)。渲染位置在 NavRail 顶部(App 拼装)。
// - 拖拽热区铁律:Tauri 按事件目标**自身**的 data-tauri-drag-region 判定,
//   不继承——条内每个可见的非交互子节点都要单独带;交互按钮不许带。
//   带该属性的区域双击 = 切换最大化(Tauri 原生行为,无需自绑)。
import { useEffect, useState } from "react";

import { useI18n } from "@/lib/i18n";

import { inDesktopShell, listen } from "@/lib/ipc/ipc";
import {
  windowClose,
  windowIsMaximized,
  windowMinimize,
  windowToggleFullscreen,
  windowToggleMaximize,
} from "@/lib/ipc/host";

function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!inDesktopShell()) return;
    let alive = true;
    const refresh = () => {
      void windowIsMaximized().then((v) => {
        if (alive) setMaximized(v);
      });
    };
    refresh();
    const off = listen("tauri://resize", refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return maximized;
}

/** 窗口失焦跟踪:mac 红绿灯失焦整组退灰(原生同款行为)。 */
function useWindowBlurred(): boolean {
  const [blurred, setBlurred] = useState(false);
  useEffect(() => {
    const onFocus = () => setBlurred(false);
    const onBlur = () => setBlurred(true);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return blurred;
}

const CAPTION_GLYPH = { strokeWidth: 1.1, stroke: "currentColor", fill: "none" } as const;

export function TitleBar() {
  const { t } = useI18n();
  const maximized = useMaximized();
  return (
    <header
      data-tauri-drag-region=""
      data-window-titlebar=""
      className="flex h-9 shrink-0 items-stretch select-none"
    >
      {/* 左侧分段与内容区各列同宽同色(w-rail/w-side 令牌),竖分隔线贯通 */}
      <div data-tauri-drag-region="" className="flex w-rail items-center justify-center bg-base-300" />
      <div data-tauri-drag-region="" className="flex w-side items-center bg-base-200 px-3">
        <span data-tauri-drag-region="" className="text-xs font-semibold text-base-content/60">
          MonkeyCode
        </span>
      </div>
      <div data-tauri-drag-region="" className="flex-1 bg-base-100" />
      <div className="flex bg-base-100">
        <button
          type="button"
          aria-label={t("titlebar.minimize")}
          className="flex w-12 cursor-default items-center justify-center text-base-content/70 transition-colors duration-150 hover:bg-base-content/10"
          onClick={windowMinimize}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" {...CAPTION_GLYPH} aria-hidden>
            <path d="M0 5h10" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
          className="flex w-12 cursor-default items-center justify-center text-base-content/70 transition-colors duration-150 hover:bg-base-content/10"
          onClick={windowToggleMaximize}
        >
          {maximized ? (
            // 还原:双框字形
            <svg width="10" height="10" viewBox="0 0 10 10" {...CAPTION_GLYPH} aria-hidden>
              <path d="M2.5 2.5V.5h7v7h-2" />
              <rect x="0.5" y="2.5" width="7" height="7" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" {...CAPTION_GLYPH} aria-hidden>
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>
        <button
          type="button"
          aria-label={t("titlebar.close")}
          className="flex w-12 cursor-default items-center justify-center text-base-content/70 transition-colors duration-150 hover:bg-caption-close hover:text-white"
          onClick={windowClose}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" {...CAPTION_GLYPH} aria-hidden>
            <path d="M0 0l10 10M10 0L0 10" />
          </svg>
        </button>
      </div>
    </header>
  );
}

// dot 是完整字面量类串(不动态拼,Tailwind 扫描依赖源码文本):
// 本色 → 失焦整组退灰 → 悬停(即使失焦)恢复本色,后者优先级靠书写顺序。
const MAC_LIGHTS = [
  {
    key: "close",
    labelKey: "titlebar.close" as const,
    dot: "bg-mac-close group-data-[blurred]:bg-base-content/20 group-hover:bg-mac-close",
    glyph: <path d="M2 2l4 4M6 2L2 6" />,
  },
  {
    key: "min",
    labelKey: "titlebar.minimize" as const,
    dot: "bg-mac-min group-data-[blurred]:bg-base-content/20 group-hover:bg-mac-min",
    glyph: <path d="M1.5 4h5" />,
  },
  {
    key: "zoom",
    labelKey: "titlebar.zoom" as const,
    dot: "bg-mac-zoom group-data-[blurred]:bg-base-content/20 group-hover:bg-mac-zoom",
    glyph: <path d="M2 5.6V2h3.6M6 2.4V6H2.4" />,
  },
] as const;

export function MacWindowControls({ compact = false }: { compact?: boolean } = {}) {
  const { t } = useI18n();
  const blurred = useWindowBlurred();
  const act = (key: (typeof MAC_LIGHTS)[number]["key"], alt: boolean) => {
    if (key === "close") return windowClose();
    if (key === "min") return windowMinimize();
    // mac 原生行为:绿点默认全屏,⌥ 点击才是最大化
    if (alt) return windowToggleMaximize();
    void windowToggleFullscreen();
  };
  return (
    <div
      data-tauri-drag-region=""
      data-blurred={blurred || undefined}
      className={`group flex items-center gap-2 ${compact ? "h-full px-3" : "px-3 py-4"}`}
    >
      {MAC_LIGHTS.map((light) => (
        <button
          key={light.key}
          type="button"
          aria-label={t(light.labelKey)}
          /* mac 惯例:窗口按钮不是手型;失焦整组退灰、悬停恢复本色并浮现字形 */
          className="flex h-3.5 w-3.5 cursor-default items-center justify-center"
          onClick={(e) => act(light.key, e.altKey)}
        >
          <span
            aria-hidden
            className={`flex h-2.5 w-2.5 items-center justify-center rounded-full text-black/60 ${light.dot}`}
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              className="opacity-0 group-hover:opacity-100"
              aria-hidden
            >
              {light.glyph}
            </svg>
          </span>
        </button>
      ))}
    </div>
  );
}

