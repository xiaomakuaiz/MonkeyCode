import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 桌面壳前端(标准 Tauri 布局)。uidist 是纯生成物(gitignore,不入库):
// public/ 里的壳页面(pet/error/音效)与 webfonts 是源码,构建时由 Vite
// 拷入;emptyOutDir 开启,每次构建从零输出,无旧产物堆积。
// 打包经 tauri beforeBuildCommand 自动构建;直接 cargo build 前需先
// npm run build 一次(uidist 缺失时 tauri 宏报错提示)。
//
// 开发期 HMR:`npx tauri dev --config tauri.dev.conf.json`(public/ 由
// dev server 原生提供,字体/壳页面同源可用)。devUrl 放 overlay 而非主
// 配置:tauri-build 给所有 debug 构建打 cfg(dev),主配置带 devUrl 会让
// 直接 cargo run 的调试二进制去连不存在的 dev server。
export default defineConfig({
  plugins: [react()],
  // KaTeX / Mermaid 的 worker 自身要动态 import 各自的重库,而 Vite 默认的
  // iife worker 格式不支持代码分割(构建直接报错)。ES module worker 需要
  // Chromium 80+ / Safari 15+;Win7 WebView2 停在 109,够。更老的 WKWebView
  // 构造 worker 会抛,main.tsx 已包 try/catch,降级为主线程渲染而不是白屏。
  worker: { format: "es" },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../uidist",
    emptyOutDir: true,
  },
});
