import { setKaTeXWorker, setMermaidWorker } from "markstream-react";
import KatexWorker from "markstream-react/workers/katexRenderer.worker?worker";
import MermaidWorker from "markstream-react/workers/mermaidParser.worker?worker";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { inDesktopShell, isMacShell } from "./host";
import { openTextContextMenu } from "./contextMenu";
import { invoke } from "./ipc";
import { startPerfProbe } from "./perf/perfProbe";
import { applyStoredTheme } from "./theme";
// 库自带样式先于本应用样式引入:排版/配色的最终话语权仍在 styles.css
// (`.md p` 这类"类+元素"选择器的优先级高于库里的单类工具类)。
import "markstream-react/index.css";
import "katex/dist/katex.min.css";
import "./styles.css";

// KaTeX / Mermaid 的解析与排版挪到 worker:这两样都是重活,留在主线程就等于
// 在流式渲染的关键路径上插一段几十毫秒的同步计算 —— 正是这次改造要消灭的东西。
// 注册放在应用入口而不是 markdown.tsx:`?worker` 是 Vite 语法,node 测试环境
// 解析不了,渲染层要保持可在 node 下 renderToStaticMarkup。
//
// 包 try/catch:这两个 worker 是 ES module 格式(见 vite.config.ts 的说明),
// 老 WKWebView 构造会抛。worker 只是把重活挪走的优化,拿不到就退回主线程渲染 ——
// 不能让一个可选优化把整个应用入口炸掉。
try {
  setMermaidWorker(new MermaidWorker());
  setKaTeXWorker(new KatexWorker());
} catch {
  /* 主线程渲染兜底 */
}

// 主题偏好在首帧前落到根节点:深色下不会先闪一帧浅色底
applyStoredTheme();

// 渲染性能探针:仅 ?perf=1 时启用,默认零开销(见 perf/perfProbe.ts)
startPerfProbe();

// 平台也落到根节点:mac 壳的原生红绿灯直接盖在 UI 左上角(Overlay 标题栏),
// 最左栏要为它让出宽度。具体宽度是布局的事,写在 styles.css 的 .mc-nav-rail;
// 这里只声明"我是谁"。判定不成立时按非 mac 走,即维持原样、不会崩。
if (isMacShell()) document.documentElement.dataset.platform = "mac";

// 桌面壳内屏蔽 WebView 默认右键菜单:原生菜单固定带"检查元素/重新加载"等
// 浏览器项且平台 API 裁不掉单项,壳内一律拦截,文本复制/粘贴走自绘菜单
// (contextMenu.ts)。浏览器模式不干预。
// 壳判定放进处理器而非注册时:不依赖 __TAURI__ 注入与模块求值的先后
window.addEventListener("contextmenu", (e) => {
  if (!inDesktopShell()) return;
  e.preventDefault();
  openTextContextMenu(e);
});

// devtools 排障入口改走快捷键(F12 / Ctrl|Cmd+Shift+I):右键不再暴露
// "检查元素",能力本身保留(Cargo devtools feature 未动,线上排障还靠它)
window.addEventListener("keydown", (e) => {
  if (!inDesktopShell()) return;
  if (e.key !== "F12" && !((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyI")) return;
  e.preventDefault();
  void invoke("open_devtools").catch(() => {});
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
