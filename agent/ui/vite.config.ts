import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// 打成单文件 index.html:内核 serve 以 []byte 形式 go:embed,
// 输出目录直接指向 cmd/mc-agent/uidist(构建产物入库,go build 不依赖 node)。
// emptyOutDir 必须关:uidist/fonts/ 是手工入库的 webfont 资产(约 20MB,
// 不走 vite 管线以免 public/uidist 在 git 里存两份),清目录会把它抹掉;
// 单文件构建只产出 index.html,不存在旧产物堆积问题。
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "../cmd/mc-agent/uidist",
    emptyOutDir: false,
  },
});
