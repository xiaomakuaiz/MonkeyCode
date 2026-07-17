import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { isSettingsWindow } from "./client";
import { SettingsWindow } from "./settings";
import "./styles.css";

// 壳的独立设置窗口与主窗口加载同一 bundle,URL 带 view=settings 时
// 只渲染设置视图(不建 WS、不恢复会话)。
createRoot(document.getElementById("root")!).render(
  <StrictMode>{isSettingsWindow() ? <SettingsWindow /> : <App />}</StrictMode>,
);
