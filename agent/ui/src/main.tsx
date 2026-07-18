import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { inDesktopShell } from "./client";
import "./styles.css";

// 桌面壳内屏蔽 WebView 默认右键菜单(重新加载/检查元素等浏览器项);
// 输入框与选中文本保留系统菜单(复制/粘贴依赖它)。浏览器模式不干预。
// 壳判定放进处理器而非注册时:不依赖 __TAURI__ 注入与模块求值的先后
window.addEventListener("contextmenu", (e) => {
  if (!inDesktopShell()) return;
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest("input, textarea, [contenteditable='true']")) return;
  if (window.getSelection()?.toString()) return;
  e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
