// 壳层拼装:Windows 自绘标题栏 + 三栏骨架(rail / 侧栏 / 主区)。
// P1 阶段 rail 与侧栏是占位(P2 落会话列表),主区暂驻主题演示卡
// (P5 移入设置页外观区)。
import { useEffect, useState } from "react";

import { MacWindowControls, TitleBar } from "@/features/titlebar/TitleBar";
import { hostInfo, isMacShell, isWindowsShell, type HostInfo } from "@/lib/ipc/host";
import { readTheme, setTheme, THEMES, type Theme } from "@/lib/theme";

function NavRail() {
  return (
    <nav aria-label="空间导航" className="flex w-rail shrink-0 flex-col items-center bg-base-300">
      {/* mac 壳:原生红绿灯隐藏,自绘替身收在 rail 顶部(62px 栏内) */}
      {isMacShell() ? <MacWindowControls /> : <div data-tauri-drag-region="" className="h-9 w-full" />}
      <div className="flex flex-1 flex-col items-center gap-2 py-2">
        {/* P2:三空间切换按钮落位 */}
        <div className="skeleton h-9 w-9 rounded-lg" />
        <div className="skeleton h-9 w-9 rounded-lg" />
      </div>
    </nav>
  );
}

function SidebarPanel() {
  return (
    <aside aria-label="会话列表" className="flex w-side shrink-0 flex-col gap-2 bg-base-200 p-3">
      {/* P2:搜索框 + 项目分组 + 会话行落位 */}
      <div className="skeleton h-8 w-full" />
      <div className="skeleton h-6 w-3/4" />
      <div className="skeleton h-6 w-full" />
      <div className="skeleton h-6 w-5/6" />
    </aside>
  );
}

function MainArea() {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [info, setInfo] = useState<HostInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void hostInfo().then((v) => {
      if (alive) setInfo(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  const pick = (next: Theme) => {
    setTheme(next);
    setThemeState(next);
  };

  return (
    <main className="flex min-w-0 flex-1 items-center justify-center bg-base-100">
      <div className="card w-96 border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-3">
          <h1 className="card-title text-base">MonkeyCode</h1>
          <p className="text-sm text-base-content/70">
            ui-next 壳骨架(P1)· daisyUI {THEMES.length} 套主题全量可选
          </p>
          <select
            aria-label="外观主题"
            className="select select-sm"
            value={theme}
            onChange={(e) => pick(e.target.value as Theme)}
          >
            {THEMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-1.5" aria-hidden>
            <span className="badge badge-primary badge-sm">primary</span>
            <span className="badge badge-secondary badge-sm">secondary</span>
            <span className="badge badge-accent badge-sm">accent</span>
            <span className="badge badge-success badge-sm">success</span>
            <span className="badge badge-warning badge-sm">warning</span>
            <span className="badge badge-error badge-sm">error</span>
          </div>
          <p className="text-xs text-base-content/50">
            切换立即生效并记在本机(mc.theme)。
            {info && ` 壳 ${info.version} · 引擎 ${info.engine_version ?? "未就绪"}`}
          </p>
        </div>
      </div>
    </main>
  );
}

export function App() {
  return (
    <div className="flex h-full flex-col text-base-content">
      {isWindowsShell() && <TitleBar />}
      <div className="flex min-h-0 flex-1">
        <NavRail />
        <SidebarPanel />
        <MainArea />
      </div>
    </div>
  );
}
