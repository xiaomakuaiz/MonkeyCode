import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
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

const root = document.getElementById("root");
if (!root) throw new Error("index.html 缺 #root 挂载点");
createRoot(root).render(<App />);
