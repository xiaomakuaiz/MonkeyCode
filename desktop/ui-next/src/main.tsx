import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import { installShellChrome } from "@/app/shellChrome";
import { applyPlatformAttr } from "@/lib/ipc/host";
import { applyStoredTheme } from "@/lib/theme";
import "@/styles/app.css";
import "@/styles/chrome.css";
import "@/styles/md.css";
import "@/styles/term.css";

// 首帧主题由 index.html 内联脚本落;这里兜底(脚本被 CSP 之类挡掉时)
applyStoredTheme();
// data-platform 落根节点(mac 红绿灯让位等平台分支的依据)
applyPlatformAttr();
// 壳级 chrome:右键拦截换自绘文本菜单、F12 devtools(浏览器模式不装)
installShellChrome();

const root = document.getElementById("root");
if (!root) throw new Error("index.html 缺 #root 挂载点");
createRoot(root).render(<App />);
