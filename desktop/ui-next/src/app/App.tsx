// 壳层拼装:标题栏 + 三栏(空间 rail / 侧栏 / 主区)+ 新建任务弹窗。
// 主区当前是欢迎卡/会话占位卡(P3 接聊天流);设置入口 P5 落位。
import { useEffect, useState } from "react";

import { ChatView } from "@/features/chat/ChatView";
import { DownloadsDock } from "@/features/downloads/DownloadsDock";
import { EngineBanner } from "@/features/engine/EngineBanner";
import { NewTaskModal } from "@/features/newtask/NewTaskModal";
import { SettingsView } from "@/features/settings/SettingsView";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { MacWindowControls, TitleBar } from "@/features/titlebar/TitleBar";
import { useI18n } from "@/lib/i18n";
import {
  hostInfo,
  isMacShell,
  isWindowsShell,
  sessionIdFromUiIntent,
  setWindowTitle,
  takeUiIntent,
  type HostInfo,
} from "@/lib/ipc/host";
import { listen } from "@/lib/ipc/ipc";
import { onSessionEvent, sessionDelete, sessionPatch, sessionsList, type SessionMeta } from "@/lib/ipc/sessions";
import { readLastSession, readSpace, writeLastSession, writeSpace, type Space } from "@/lib/util/prefs";

const SPACE_ICONS: Record<Space, string> = {
  // 简笔图形占位:P9 前统一换成正式 icon 集
  local: "M3 5h18v12H3zM3 20h18",
  cloud: "M7 17a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 9a4 4 0 0 1-1 7.9z",
  chat: "M4 5h16v10H9l-5 4z",
};

function SpaceRail({
  space,
  waiting,
  onChange,
  onOpenSettings,
}: {
  space: Space;
  waiting: number;
  onChange: (s: Space) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const labels: Record<Space, string> = { local: t("rail.local"), cloud: t("rail.cloud"), chat: t("rail.chat") };
  return (
    <nav aria-label={t("rail.label")} className="flex w-rail shrink-0 flex-col items-center bg-base-300">
      {isMacShell() ? <MacWindowControls /> : <div data-tauri-drag-region="" className="h-9 w-full shrink-0" />}
      <div className="flex flex-1 flex-col items-center gap-1 py-1">
        {(["local", "cloud", "chat"] as const).map((s) => (
          <div key={s} className={s === "local" && waiting > 0 ? "indicator" : undefined}>
            {s === "local" && waiting > 0 && (
              <span className="indicator-item badge badge-warning badge-xs">{waiting}</span>
            )}
            <button
              type="button"
              aria-label={labels[s]}
              aria-pressed={space === s}
              title={labels[s]}
              className={`btn btn-square btn-ghost btn-sm ${space === s ? "btn-active text-primary" : "text-base-content/60"}`}
              onClick={() => onChange(s)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
                <path d={SPACE_ICONS[s]} />
              </svg>
            </button>
          </div>
        ))}
      </div>
      <div className="pb-2">
        <button
          type="button"
          aria-label={t("rail.settings")}
          title={t("rail.settings")}
          className="btn btn-square btn-ghost btn-sm text-base-content/60"
          onClick={onOpenSettings}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
          </svg>
        </button>
      </div>
    </nav>
  );
}

function MainArea({ current }: { current: SessionMeta | null }) {
  const { t } = useI18n();
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

  if (current) return <ChatView meta={current} />;

  return (
    <main className="flex min-w-0 flex-1 items-center justify-center bg-base-100 p-6">
      <div className="card w-96 border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-2">
          <h1 className="card-title text-base">{t("main.welcome.title")}</h1>
          <p className="text-sm text-base-content/70">{t("main.welcome.detail")}</p>
          {info && (
            <p className="text-xs text-base-content/50">
              {t("main.shellInfo", { version: info.version, engine: info.engine_version ?? t("main.engineNotReady") })}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

export function App() {
  const { t } = useI18n();
  const [space, setSpaceState] = useState<Space>(readSpace);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(readLastSession);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refresh = () => void sessionsList().then(setSessions);

  useEffect(() => {
    // 壳意图:启动补取一次(窗口唤起前托盘/桌宠塞的),再听后续推送
    void takeUiIntent().then((intent) => {
      if (intent === "open-settings") {
        setSettingsOpen(true);
        return;
      }
      const id = sessionIdFromUiIntent(intent);
      if (id) {
        setCurrentId(id);
        writeLastSession(id);
      }
    });
    const offOpenSettings = listen<void>("open-settings", () => setSettingsOpen(true));
    const offOpenSession = listen<string>("open-session", (id) => {
      if (!id) return;
      setCurrentId(id);
      writeLastSession(id);
    });
    refresh();
    // 后台会话状态/摘要/审批等待:全局事件驱动,不轮询
    const off = onSessionEvent((e) => {
      setSessions((list) =>
        list.map((m) =>
          m.id === e.id
            ? {
                ...m,
                title: e.title || m.title,
                status: e.status ?? m.status,
                summary: e.summary ?? m.summary,
                waiting_ask: e.type === "session-ask" ? e.open : m.waiting_ask,
              }
            : m,
        ),
      );
    });
    return () => {
      off();
      offOpenSession();
      offOpenSettings();
    };
  }, []);

  const current = sessions.find((m) => m.id === currentId) ?? null;

  useEffect(() => {
    setWindowTitle(current ? `${current.title} — ${t("app.name")}` : t("app.name"));
  }, [current, t]);

  const setSpace = (next: Space) => {
    setSpaceState(next);
    writeSpace(next);
  };

  const select = (meta: SessionMeta) => {
    setCurrentId(meta.id);
    writeLastSession(meta.id);
  };

  const waiting = sessions.filter((m) => m.kind !== "chat" && m.waiting_ask).length;

  return (
    <div className="flex h-full flex-col text-base-content">
      {isWindowsShell() && <TitleBar />}
      <EngineBanner />
      <div className="flex min-h-0 flex-1">
        <SpaceRail space={space} waiting={waiting} onChange={setSpace} onOpenSettings={() => setSettingsOpen(true)} />
        <Sidebar
          space={space}
          sessions={sessions}
          currentId={currentId}
          actions={{
            onSelect: select,
            onNewTask: () => setCreating(true),
            onDelete: (meta) => {
              void sessionDelete(meta.id)
                .catch(() => {})
                .then(() => {
                  if (currentId === meta.id) setCurrentId(null);
                  refresh();
                });
            },
            onToggleArchive: (meta) => {
              void sessionPatch(meta.id, { archived: !meta.archived })
                .catch(() => {})
                .then(refresh);
            },
          }}
        />
        {settingsOpen ? <SettingsView onClose={() => setSettingsOpen(false)} /> : <MainArea current={current} />}
      </div>
      <DownloadsDock />
      <NewTaskModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(meta) => {
          refresh();
          select(meta);
          if (meta.kind === "chat") setSpace("chat");
          else setSpace("local");
        }}
      />
    </div>
  );
}
