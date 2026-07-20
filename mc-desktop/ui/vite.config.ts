import { createReadStream, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// 桌面壳前端(标准 Tauri 布局:前端与 src 同属 mc-desktop 应用目录)。
// 构建产物输出到 ../uidist(frontendDist,产物入库,cargo build 不依赖 node;
// 改 UI 后在此执行 npm run build)。
// emptyOutDir 必须关:uidist/ 内有手工入库的 webfont 资产(约 20MB)与壳
// 自有页面(pet.html/error.html/音效),清目录会把它们抹掉。
// 注意:hash 命名的旧 assets 会随多次构建堆积,重新构建前可手工清理 uidist/assets。
//
// 开发期 HMR(可选):`npx tauri dev --config tauri.dev.conf.json` 会经
// beforeDevCommand 拉起本 dev server(端口 1420)。devUrl 放 overlay 而非
// 主配置:tauri-build 给所有 debug 构建打 cfg(dev),主配置里配 devUrl 会让
// 直接 cargo run 的调试二进制去连不存在的 dev server。

/** dev server 补挂 /fonts:webfont 资产在 uidist/ 不在 vite 根,不代理则
 * 开发期字体 404 回退系统字体(渲染失真)。 */
function serveUidistFonts(): Plugin {
  const fontsDir = resolve(__dirname, "../uidist/fonts");
  return {
    name: "serve-uidist-fonts",
    configureServer(server) {
      server.middlewares.use("/fonts", (req, res, next) => {
        const name = (req.url ?? "").split("?")[0].replace(/^\//, "");
        if (!name || name.includes("..")) return next();
        const file = join(fontsDir, name);
        if (!existsSync(file)) return next();
        res.setHeader(
          "Content-Type",
          name.endsWith(".css") ? "text/css" : "font/woff2",
        );
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveUidistFonts()],
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../uidist",
    emptyOutDir: false,
  },
});
