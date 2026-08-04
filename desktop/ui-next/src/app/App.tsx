// 壳层拼装:标题栏 + 三栏(空间 rail / 侧栏 / 主区)+ 新建任务弹窗。
// 主区当前是欢迎卡/会话占位卡(P3 接聊天流);设置入口 P5 落位。
// App 级职责还有四件事件驱动的"粘合":
// - D1 引擎重启自愈:engine-status 记住"曾不可用",Ready 后重拉列表并给
//   ChatView 递 epoch 重开信号(保存设置/手动重启/崩溃自愈统一收敛,不分支);
// - D3 后台会话提醒:非当前会话等待审批/转终态 → 可点击跳转的 toast +
//   侧栏 attention 高亮;
// - D8 增量自愈:session-event/意图指向未知 id → 重拉全表再选中;
// - H9 意图消费:open-* 事件送达即 takeUiIntent 消费壳侧副本,防刷新重放。
import { Cloud, FolderGit2, MessagesSquare, Settings, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ChatView } from "@/features/chat/ChatView";
import { CloudTaskView } from "@/features/cloud/CloudTaskView";
import { DownloadsDock } from "@/features/downloads/DownloadsDock";
import { EngineBanner } from "@/features/engine/EngineBanner";
import { NewTaskModal } from "@/features/newtask/NewTaskModal";
import { SettingsView } from "@/features/settings/SettingsView";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { MacWindowControls, TitleBar } from "@/features/titlebar/TitleBar";
import { useI18n, type MessageKey } from "@/lib/i18n";
import {
  hostInfo,
  isMacShell,
  isWindowsShell,
  sessionIdFromUiIntent,
  setWindowTitle,
  takeUiIntent,
  type HostInfo,
} from "@/lib/ipc/host";
import { inDesktopShell, listen } from "@/lib/ipc/ipc";
import { engineStatus, onEngineStatus, type EngineStatus } from "@/lib/ipc/engine";
import type { CloudTask } from "@/lib/ipc/cloudtasks";
import {
  modelsList,
  onSessionEvent,
  sessionDelete,
  sessionPatch,
  sessionsList,
  type SessionMeta,
} from "@/lib/ipc/sessions";
import { noticeForSessionEvent, type NoticeKind, type SessionNotice } from "@/lib/notices";
import { readLastSession, readSpace, writeLastSession, writeSpace, type Space } from "@/lib/util/prefs";
import { projectKey, readArchivedProjects } from "@/lib/util/projects";

// 统一图标族:lucide(一致的描边宽度与圆角语言)
const SPACE_ICONS: Record<Space, typeof FolderGit2> = {
  local: FolderGit2,
  cloud: Cloud,
  chat: MessagesSquare,
};

const NOTICE_TONE: Record<NoticeKind, string> = {
  ask: "alert-warning",
  done: "alert-success",
  error: "alert-error",
};

const NOTICE_TEXT: Record<NoticeKind, MessageKey> = {
  ask: "notice.ask",
  done: "notice.done",
  error: "notice.error",
};

function SpaceRail({
  space,
  waiting,
  onChange,
  settingsOpen,
  onToggleSettings,
}: {
  space: Space;
  waiting: number;
  onChange: (s: Space) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
}) {
  const { t } = useI18n();
  const labels: Record<Space, string> = { local: t("rail.local"), cloud: t("rail.cloud"), chat: t("rail.chat") };
  return (
    <nav aria-label={t("rail.label")} className="flex w-rail shrink-0 flex-col items-center bg-base-300">
      {/* 头部基线:mac 红绿灯待在 chrome 角落(h-13 = 52px,与各列头部同高);
          其余环境同高空位,保证三列头部线对齐 */}
      {isMacShell() ? (
        <div data-tauri-drag-region="" className="flex h-13 w-full shrink-0 items-center">
          <MacWindowControls compact />
        </div>
      ) : (
        !isWindowsShell() && <div className="h-13 w-full shrink-0" />
      )}
      <div className="flex flex-1 flex-col items-center gap-1 py-1">
        {(["local", "cloud", "chat"] as const).map((s) => (
          <div key={s} className={s === "local" && waiting > 0 ? "indicator" : undefined}>
            {s === "local" && waiting > 0 && (
              <span className="indicator-item badge badge-warning badge-xs">{waiting}</span>
            )}
            {/* 44px 命中区;悬停 tooltip 替代原生 title */}
            <button
              type="button"
              aria-label={labels[s]}
              aria-pressed={space === s}
              data-tip={labels[s]}
              className={`btn btn-ghost btn-square tooltip tooltip-right size-11 ${space === s ? "btn-active" : ""}`}
              onClick={() => onChange(s)}
            >
              {(() => {
                const Icon = SPACE_ICONS[s];
                return <Icon size={18} strokeWidth={1.75} aria-hidden />;
              })()}
            </button>
          </div>
        ))}
      </div>
      <div className="pb-2">
        <button
          type="button"
          aria-label={t("rail.settings")}
          aria-pressed={settingsOpen}
          data-tip={t("rail.settings")}
          className={`btn btn-ghost btn-square tooltip tooltip-right size-11 ${settingsOpen ? "btn-active" : ""}`}
          onClick={onToggleSettings}
        >
          <Settings size={18} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </nav>
  );
}

function MainArea({ current, epoch }: { current: SessionMeta | null; epoch: number }) {
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

  if (current) return <ChatView meta={current} epoch={epoch} />;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-base-100">
      <div data-tauri-drag-region="" className="h-13 shrink-0 border-b border-base-300" />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-6">
      <img src="/logo.png" alt="" className="h-16 w-16 rounded-2xl shadow-sm" aria-hidden />
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h1 className="text-lg font-bold tracking-tight">{t("main.welcome.title")}</h1>
        <p className="max-w-sm text-sm leading-relaxed text-base-content/60">{t("main.welcome.detail")}</p>
      </div>
      {info && (
        <p className="font-mono text-[11px] text-base-content/35 tabular-nums">
          {t("main.shellInfo", { version: info.version, engine: info.engine_version ?? t("main.engineNotReady") })}
        </p>
      )}
      </div>
    </main>
  );
}

export function App() {
  const { t } = useI18n();
  const [space, setSpaceState] = useState<Space>(readSpace);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(readLastSession);
  // 新建任务视图:null=关;{dir} 可携带「在此项目新建」的预填目录
  const [creating, setCreating] = useState<{ dir?: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cloudTask, setCloudTask] = useState<CloudTask | null>(null);
  const [cloudReload, setCloudReload] = useState(0);
  const [notices, setNotices] = useState<SessionNotice[]>([]);
  const [attentionIds, setAttentionIds] = useState<Set<string>>(new Set());
  // D1:引擎自愈的重开信号(ChatView 经 useSessionFeed 依赖幂等重建连接)
  const [epoch, setEpoch] = useState(0);

  // 事件回调挂一次,经 ref 读最新快照(闭包不攥旧状态)
  const sessionsRef = useRef<SessionMeta[]>(sessions);
  sessionsRef.current = sessions;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  const refresh = () => void sessionsList().then(setSessions);

  const setSpace = (next: Space) => {
    setSpaceState(next);
    writeSpace(next);
    // 桌面客户端心智:点导航永远切走当前覆盖视图(设置/新建),不会"没反应"
    setSettingsOpen(false);
    setCreating(null);
  };

  /** 摘掉某会话的提醒与侧栏 attention(打开它即视为已读)。 */
  const dismissSession = (id: string) => {
    setNotices((list) => list.filter((n) => n.sessionId !== id));
    setAttentionIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  /** 按 id 打开会话(提醒点击/壳意图共用)。D8:不在本地快照的 id 先重拉
   *  全表再选中;找到 meta 时按 kind 切空间(chat→chat,其余→local)。 */
  const openSessionById = async (id: string) => {
    let meta = sessionsRef.current.find((m) => m.id === id);
    if (!meta) {
      const list = await sessionsList();
      setSessions(list);
      meta = list.find((m) => m.id === id);
    }
    setCurrentId(id);
    writeLastSession(id);
    setSettingsOpen(false);
    if (meta) setSpace(meta.kind === "chat" ? "chat" : "local");
    dismissSession(id);
  };
  const openSessionByIdRef = useRef(openSessionById);
  openSessionByIdRef.current = openSessionById;

  useEffect(() => {
    let alive = true;
    // 壳意图:启动补取一次(窗口唤起前托盘/桌宠塞的),再听后续推送
    void takeUiIntent().then((intent) => {
      if (!alive) return;
      if (intent === "open-settings") {
        setSettingsOpen(true);
        return;
      }
      const id = sessionIdFromUiIntent(intent);
      if (id) void openSessionByIdRef.current(id);
    });
    // H9:事件送达立即消费壳侧意图副本——不消费的话整页刷新会重放同一意图
    const offOpenSettings = listen<void>("open-settings", () => {
      void takeUiIntent();
      setSettingsOpen(true);
    });
    const offOpenSession = listen<string>("open-session", (id) => {
      void takeUiIntent();
      if (!id) return;
      void openSessionByIdRef.current(id);
    });
    refresh();
    // D5 首启向导:桌面壳里模型清单为空 → 自动打开设置页。只在挂载时判一次:
    // 用户关掉设置页不再纠缠,配好模型后自然不会再触发。
    if (inDesktopShell()) {
      void modelsList().then((models) => {
        if (alive && models.length === 0) setSettingsOpen(true);
      });
    }
    // 后台会话状态/摘要/审批等待:全局事件驱动,不轮询
    const off = onSessionEvent((e) => {
      if (sessionsRef.current.some((m) => m.id === e.id)) {
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
      } else {
        // D8:未知 id = 本地增量快照已失真(别处新建/漏事件),重拉全表
        refresh();
      }
      // D3:非当前会话的等待审批/终态提醒(文案取自事件本身,不依赖列表快照)
      const notice = noticeForSessionEvent(e, currentIdRef.current);
      if (!notice) return;
      setNotices((list) => [...list.filter((n) => n.sessionId !== notice.sessionId), notice]);
      setAttentionIds((prev) => (prev.has(notice.sessionId) ? prev : new Set(prev).add(notice.sessionId)));
    });
    return () => {
      alive = false;
      off();
      offOpenSession();
      offOpenSettings();
    };
  }, []);

  // D1 引擎重启自愈:记住"曾不可用",Ready 后重拉会话列表并自增 epoch。
  // 保存设置/手动重启/崩溃自愈统一收敛于 engine-status,不做特殊分支;
  // 模型清单无缓存模块(composer/新建弹窗挂载即重拉),无需失效动作。
  const engineDownRef = useRef(false);
  useEffect(() => {
    let alive = true;
    // 事件与快照走同一条判定:页面可能恰好在退避窗口里加载,只靠事件会漏记 down
    const apply = (s: EngineStatus) => {
      if (s.phase === "ready") {
        if (engineDownRef.current) {
          engineDownRef.current = false;
          refresh();
          setEpoch((n) => n + 1);
        }
        return;
      }
      // stopped 不记也不清:它只是冷启动前与重启中途的正常过站
      if (s.phase !== "stopped") engineDownRef.current = true;
    };
    const off = onEngineStatus((s) => {
      if (alive) apply(s);
    });
    // 状态可能早于窗口存在(冷启动失败/崩溃),挂上监听后补拉一次快照
    void engineStatus().then((s) => {
      if (alive && s) apply(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const current = sessions.find((m) => m.id === currentId) ?? null;

  useEffect(() => {
    setWindowTitle(current ? `${current.title} — ${t("app.name")}` : t("app.name"));
  }, [current, t]);

  const select = (meta: SessionMeta) => {
    setCurrentId(meta.id);
    writeLastSession(meta.id);
    dismissSession(meta.id);
    setSettingsOpen(false);
    setCreating(null);
  };

  const waiting = sessions.filter((m) => m.kind !== "chat" && m.waiting_ask).length;

  // 新建弹窗的最近目录:非 chat、未归档(会话与项目两级),按最近活跃排,项目 key 去重
  const recentDirs = (() => {
    const archivedProjects = readArchivedProjects();
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const m of [...sessions]
      .filter((s) => s.kind !== "chat" && !s.archived && s.workdir)
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))) {
      const key = projectKey(m.workdir);
      if (seen.has(key) || archivedProjects.has(key)) continue;
      seen.add(key);
      dirs.push(m.workdir);
    }
    return dirs;
  })();

  return (
    <div className="flex h-full flex-col text-base-content">
      {isWindowsShell() && <TitleBar />}
      <EngineBanner />
      <div className="flex min-h-0 flex-1">
        <SpaceRail space={space} waiting={waiting} onChange={setSpace} settingsOpen={settingsOpen} onToggleSettings={() => { setCreating(null); setSettingsOpen((v) => !v); }} />
        <Sidebar
          space={space}
          sessions={sessions}
          currentId={currentId}
          attentionIds={attentionIds}
          cloud={{
            currentId: cloudTask?.id ?? null,
            onSelect: setCloudTask,
            reloadKey: cloudReload,
            onDeleted: (id) => {
              if (cloudTask?.id === id) setCloudTask(null);
              setCloudReload((n) => n + 1);
            },
            onRefresh: () => setCloudReload((n) => n + 1),
          }}
          actions={{
            onSelect: select,
            onNewTask: () => {
              setSettingsOpen(false);
              setCreating({});
            },
            onNewTaskIn: (workdir) => {
              setSettingsOpen(false);
              setCreating({ dir: workdir });
            },
            onRename: (meta, title) => {
              void sessionPatch(meta.id, { title })
                .catch(() => {})
                .then(refresh);
            },
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
        {settingsOpen ? (
          <SettingsView onClose={() => setSettingsOpen(false)} />
        ) : creating ? (
          <NewTaskModal
            open
            initialDir={creating.dir}
            recentDirs={recentDirs}
            onClose={() => setCreating(null)}
            onCreated={(meta) => {
              refresh();
              select(meta);
              if (meta.kind === "chat") setSpace("chat");
              else setSpace("local");
            }}
            onCloudCreated={(task) => {
              setSpace("cloud");
              setCloudTask(task);
              setCloudReload((n) => n + 1);
            }}
          />
        ) : space === "cloud" && cloudTask ? (
          <CloudTaskView key={cloudTask.id} task={cloudTask} onTasksChanged={() => setCloudReload((n) => n + 1)} />
        ) : (
          <MainArea current={space === "cloud" ? null : current} epoch={epoch} />
        )}
      </div>
      {/* D3 后台会话提醒:可叠多条(每会话取最新一条),点击跳转、可关闭 */}
      {notices.length > 0 && (
        <div className="toast toast-top toast-end z-50 mt-9" aria-label={t("notice.label")}>
          {notices.map((n) => (
            <div key={n.sessionId} role="alert" className={`alert ${NOTICE_TONE[n.kind]} alert-soft py-2 text-xs shadow-md`}>
              <button
                type="button"
                className="link link-hover max-w-64 min-w-0 truncate text-left"
                onClick={() => void openSessionById(n.sessionId)}
              >
                {t(NOTICE_TEXT[n.kind], { title: n.title || t("notice.untitled") })}
              </button>
              <button
                type="button"
                aria-label={t("notice.dismiss")}
                className="btn btn-ghost btn-square btn-xs"
                onClick={() => setNotices((list) => list.filter((x) => x.sessionId !== n.sessionId))}
              >
                <X size={14} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
      <DownloadsDock />
    </div>
  );
}
