import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 构建产物输出到桌面壳的 frontendDist(mc-desktop/uidist,随壳分发,
// 构建产物入库,cargo build 不依赖 node;改 UI 后在此执行 npm run build)。
// emptyOutDir 必须关:uidist/ 内有手工入库的 webfont 资产(约 20MB)与壳
// 自有页面(pet.html/error.html/音效),清目录会把它们抹掉。
// 注意:hash 命名的旧 assets 会随多次构建堆积,重新构建前可手工清理 uidist/assets。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../../mc-desktop/uidist",
    emptyOutDir: false,
  },
});
