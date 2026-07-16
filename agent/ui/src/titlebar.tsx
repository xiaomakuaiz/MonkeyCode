// Windows 壳的自绘标题栏:壳去掉了原生装饰栏(decorations=false),这里补回
// 36px 的拖拽区 + 最小化/最大化/关闭按钮(跟随应用明暗主题,与界面同色融合)。
// 仅 isWindowsShell() 时由 App 渲染;mac 壳走 Overlay 红绿灯,浏览器模式无此栏。
import { useEffect, useState, type CSSProperties } from "react";
import {
  onWindowResized,
  windowClose,
  windowIsMaximized,
  windowMinimize,
  windowToggleMaximize,
} from "./client";

const btn: CSSProperties = {
  width: 46,
  height: "100%",
  border: "none",
  background: "transparent",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--t3)",
  cursor: "default", // Windows 惯例:窗口按钮不是手型
  padding: 0,
  flex: "none",
};

/** 窗口按钮图标(Windows 10/11 caption 字形,1px 细线,currentColor 随 hover 变色) */
function Glyph({ d }: { d: string }) {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" fill="none" style={{ display: "block" }}>
      <path d={d} stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const sync = () => void windowIsMaximized().then(setMaximized);
    sync();
    return onWindowResized(sync);
  }, []);

  return (
    <div
      data-tauri-drag-region=""
      style={{
        height: 36,
        flex: "none",
        display: "flex",
        alignItems: "center",
        background: "var(--bg)",
        borderBottom: "1px solid var(--line2)",
        userSelect: "none",
      }}
    >
      <span data-tauri-drag-region="" style={{ flex: 1, alignSelf: "stretch" }} />
      <button className="hv" title="最小化" onClick={() => void windowMinimize()} style={btn}>
        <Glyph d="M0 5h10" />
      </button>
      <button
        className="hv"
        title={maximized ? "向下还原" : "最大化"}
        onClick={() => void windowToggleMaximize()}
        style={btn}
      >
        {maximized ? (
          // 还原:前后两个错位方框
          <Glyph d="M.5 2.5h7v7h-7zM2.5 2.5v-2h7v7h-2" />
        ) : (
          <Glyph d="M.5 .5h9v9h-9z" />
        )}
      </button>
      <button className="hv-caption-close" title="关闭" onClick={() => void windowClose()} style={btn}>
        <Glyph d="M0 0l10 10M10 0L0 10" />
      </button>
    </div>
  );
}
