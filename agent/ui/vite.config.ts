import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// 打成单文件 index.html:内核 serve 以 []byte 形式 go:embed,
// 输出目录直接指向 cmd/mc-agent/uidist(构建产物入库,go build 不依赖 node)。
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "../cmd/mc-agent/uidist",
    emptyOutDir: true,
  },
});
