// 布局切换 + App 级浮层(改动抽屉/子会话回放/设置):侧栏常驻,主区在
// Chat / New Task / Settings 三屏间切换。会话协议状态(WS/帧归约/composer)
// 收口在 useSession 句柄里;视觉对照「MonkeyCode 桌面应用设计」。
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  baizhiStatus,
  connect,
  createSession,
  deleteSession,
  engineRestart,
  onEngineCrashed,
  inDesktopShell,
  isWindowsShell,
  getHostInfo,
  mcLogin,
  mcStatus,
  mcTasks,
  onHostEvent,
  takeUiIntent,
  listModels,
  listSessions,
  setSessionArchived,
  setSessionTitle,
  subscribeEvents,
  updateCheck,
  type CloudTask,
  type EngineCrash,
  type UpdateStatus,
} from "./client";
import { basename, ChatView } from "./chat";
import { CloudTaskView } from "./cloudtask";
import { CodeView, DiffPanel, LogList, MONO } from "./components";
import { IconChevronRight, IconFile, IconFolder, IconX } from "./icons";
import { NewTaskView } from "./newtask";
import { initialChat, reduceBatch, type ChatState } from "./reduce";
import { groupByProject, Sidebar } from "./sidebar";
import { SettingsView } from "./settings";
import TitleBar from "./titlebar";
import { lastSessionId, useSession } from "./useSession";
import type { FileChange, FileEntry, LogItem, ModelInfo, SessionMeta } from "./types";

/** 首启默认工作目录(内核解析 ~,不存在时自动创建);老用户默认沿用最近会话的目录 */
const DEFAULT_DIR = "~/MonkeyCode";

/** 内核与页面同机(serve 仅绑 loopback),浏览器 UA 即宿主平台 */
const IS_MAC = /Mac/.test(navigator.userAgent);

/** 改动状态 → 普通用户可读的中文标签与配色(git 的 A/M/D 不外显) */
const CHANGE_KIND: Record<FileChange["status"], { text: string; fg: string; bg: string }> = {
  A: { text: "新增", fg: "var(--addT)", bg: "var(--addBg)" },
  M: { text: "修改", fg: "var(--warn)", bg: "var(--warnBg)" },
  D: { text: "删除", fg: "var(--delT)", bg: "var(--delBg)" },
};

const fmtSize = (n: number) =>
  n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B";

// ---- 文件抽屉的行/标签/面包屑样式 ----
const fileRow: CSSProperties = {
  height: 32,
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "0 10px",
  borderRadius: 8,
  cursor: "pointer",
  minWidth: 0,
  flex: "none",
};
const changeTag: CSSProperties = {
  flex: "none",
  fontSize: 10.5,
  fontWeight: 600,
  borderRadius: 9,
  padding: "2px 8px",
  lineHeight: 1.4,
};
const drawerTabStyle = (active: boolean): CSSProperties => ({
  border: "none",
  background: "transparent",
  height: 34,
  padding: "0 3px",
  marginBottom: -1, // 激活下划线压在头部 hairline 上
  borderBottom: `2px solid ${active ? "var(--acc)" : "transparent"}`,
  fontSize: 13,
  fontWeight: active ? 700 : 500,
  color: active ? "var(--t1)" : "var(--t5)",
  cursor: active ? "default" : "pointer",
  display: "flex",
  alignItems: "center",
  gap: 6,
  flex: "none",
});
export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [view, setView] = useState<"new" | "session" | "settings" | "cloud">("new");
  // 页内设置视图的脏状态(浏览器回退模式;桌面走独立设置窗口):离开前确认
  const settingsDirty = useRef(false);
  const closeSettings = () => {
    if (settingsDirty.current && !window.confirm("有未保存的更改,确定离开设置?")) return;
    setView(session.id ? "session" : "new");
  };
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [hostVersion, setHostVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  // 引擎崩溃外显(engine-crashed 事件;重启成功后整页刷新复位)
  const [engineCrash, setEngineCrash] = useState<EngineCrash | null>(null);
  const [engineRestarting, setEngineRestarting] = useState(false);
  useEffect(() => onEngineCrashed(setEngineCrash), []);
  // App 级浮层;文件抽屉 = 工作区资源管理器(cwd 逐层导航 + 文件查看器)
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 两个视角共用同一预览窗格:文件(资源管理器) / 改动(本轮平铺列表)
  const [drawerTab, setDrawerTab] = useState<"files" | "changes">("files");
  // 树形浏览:目录 → 子项缓存("" = 工作区根),展开集合,按目录粒度的加载中标记
  const [tree, setTree] = useState<Map<string, FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [fsErr, setFsErr] = useState("");
  const [viewer, setViewer] = useState<{ path: string; kind: "diff" | "code" | "plain"; text: string } | null>(null);
  // 抽屉宽度可拖拽调整(记忆);拖动中置 dragging 显示把手强调色
  const [drawerW, setDrawerW] = useState(() => {
    const v = parseInt(localStorage.getItem("mc.drawerWidth") ?? "", 10);
    return Number.isFinite(v) ? Math.min(Math.max(v, 420), 1200) : 600;
  });
  const [dragging, setDragging] = useState(false);
  // 列表/预览分栏高度(px;0 = 未设置,用默认 38%),同样可拖拽并记忆
  const [splitH, setSplitH] = useState(() => {
    const v = parseInt(localStorage.getItem("mc.drawerSplit") ?? "", 10);
    return Number.isFinite(v) && v > 0 ? Math.max(v, 80) : 0;
  });
  const [splitDragging, setSplitDragging] = useState(false);
  const listRef = useRef<HTMLDivElement>(null); // 分栏拖拽的定位基准
  const [childView, setChildView] = useState<string | null>(null);
  // 新建任务视图
  const [newDir, setNewDir] = useState(DEFAULT_DIR);
  const [newModel, setNewModel] = useState("");
  const [newText, setNewText] = useState("");
  const [newErr, setNewErr] = useState("");
  const [offerCreate, setOfferCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  const dirTouchedRef = useRef(false); // 用户改过工作目录后不再跟随默认值

  // ===== 云端任务:百智云会话桥接 monkeycode 账号后自动同步 =====
  // null = 未同步(空态给登录引导);已同步后 60s 轮询任务列表
  const [cloudTasks, setCloudTasks] = useState<CloudTask[] | null>(null);
  const [mcHost, setMcHost] = useState("monkeycode-ai.com");
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const syncCloud = useCallback(async () => {
    setCloudSyncing(true);
    try {
      const st = await mcStatus();
      if (st.host) setMcHost(st.host);
      if (!st.logged_in) {
        // 云端会话缺失/失效:有百智会话就静默桥接一次,没有则保持未同步空态
        const bz = await baizhiStatus();
        if (!bz.logged_in) {
          setCloudTasks(null);
          return;
        }
        await mcLogin();
      }
      // 默认视图只展示未结束任务,取 20 条保证"历史任务"折叠区也有内容
      const r = await mcTasks(1, 20);
      setCloudTasks(r.tasks ?? []);
    } catch {
      /* 静默:云端同步失败不打扰本地使用,下次轮询/回到主界面再试 */
    } finally {
      setCloudSyncing(false);
    }
  }, []);
  // 启动即试同步;离开设置页也再试(用户可能刚在设置里登录了百智云)
  useEffect(() => {
    if (view !== "settings") void syncCloud();
  }, [view, syncCloud]);
  // 窗口重获焦点即刷新:网页/手机端刚派发的任务切回来就能看到(不等 60s 轮询)
  useEffect(() => {
    const onFocus = () => void syncCloud();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [syncCloud]);
  const cloudSynced = cloudTasks !== null;
  useEffect(() => {
    if (!cloudSynced) return;
    const t = setInterval(() => void syncCloud(), 60_000);
    return () => clearInterval(t);
  }, [cloudSynced, syncCloud]);
  // 桌面内打开的云端任务(view === "cloud" 时渲染详情视图)
  const [cloudTask, setCloudTaskOpen] = useState<CloudTask | null>(null);
  const openCloudTask = (t: CloudTask) => {
    setCloudTaskOpen(t);
    setDrawerOpen(false);
    setViewer(null);
    setView("cloud");
  };
  const closeCloudTask = () => {
    setCloudTaskOpen(null);
    setView(session.id ? "session" : "new");
    void syncCloud();
  };

  const refreshSessions = useCallback(async () => {
    const metas = await listSessions();
    setSessions(metas);
    return metas;
  }, []);

  const session = useSession({ onSessionsChanged: () => void refreshSessions() });

  // 后台会话结束提醒:内核事件流推送状态变更(不轮询),非当前会话到达终态时
  // 标记侧栏未读点 + 状态行提示;打开该会话即消除
  const [attention, setAttention] = useState<Set<string>>(new Set());
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;
  const notifyRef = useRef(session.notify);
  notifyRef.current = session.notify;
  useEffect(
    () =>
      subscribeEvents((e) => {
        if (e.type !== "session-status" && e.type !== "session-ask") return;
        void refreshSessions(); // waiting_ask/status 都在列表快照里,任一事件都重拉
        if (e.id === sessionIdRef.current) return;
        if (e.type === "session-ask") {
          if (e.open) notifyRef.current(`「${e.title || "任务"}」等待权限审批`);
          return;
        }
        if (e.status === "running") return;
        setAttention((prev) => new Set(prev).add(e.id));
        const label = e.status === "finished" ? "已完成" : e.status === "error" ? "出错了" : "已中断";
        notifyRef.current(`「${e.title || "任务"}」${label}`);
      }),
    [refreshSessions],
  );

  // 打开会话 = 接上句柄 + 复位 App 级浮层(无消费方需要稳定引用,不做 memo)
  const openSession = (m: { id: string; model?: string; mode?: string }, firstMessage?: string) => {
    session.open(m.id, { model: m.model, mode: m.mode, firstMessage });
    setAttention((prev) => {
      if (!prev.has(m.id)) return prev;
      const next = new Set(prev);
      next.delete(m.id);
      return next;
    });
    setView("session");
    setDrawerOpen(false);
    setViewer(null);
  };

  // 归档/取消归档:仅列表位置变化,当前打开的会话不强制关闭
  const archiveSession = async (m: SessionMeta) => {
    try {
      await setSessionArchived(m.id, !m.archived);
      await refreshSessions();
    } catch (e) {
      session.notify("⚠ 归档失败: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // 重命名会话(标题非空;当前打开的会话头部随 sessions 刷新自动更新)
  const renameSession = async (m: SessionMeta, title: string) => {
    try {
      await setSessionTitle(m.id, title);
      await refreshSessions();
    } catch (e) {
      session.notify("⚠ 重命名失败: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // 删除会话;若删的是当前打开的会话,复位回新建任务视图
  const removeSession = async (m: SessionMeta) => {
    try {
      await deleteSession(m.id);
    } catch (e) {
      session.notify("⚠ 删除失败: " + (e instanceof Error ? e.message : String(e)));
      return;
    }
    if (m.id === session.id) {
      session.close(true);
      setView("new");
      setDrawerOpen(false);
      setViewer(null);
    }
    void refreshSessions();
  };

  // 打开设置视图:先复位 App 级浮层(文件抽屉的遮罩不能盖在设置页上),
  // 与 openSession/removeSession 的复位语义对齐。侧栏齿轮与托盘事件共用。
  const settingsRequestedRef = useRef(false); // 托盘请求过设置:启动恢复会话不得覆盖
  const openSettings = () => {
    setDrawerOpen(false);
    setViewer(null);
    setView("settings");
  };

  // 启动:拉模型清单 + 恢复上次会话;桌面壳内无模型(首启/被清空)直接进设置向导。
  // 订阅壳的托盘"设置"事件(唤起页内设置视图),静默检查一次应用更新(齿轮小圆点)。
  useEffect(() => {
    const offSettings = onHostEvent("open-settings", () => {
      settingsRequestedRef.current = true;
      void takeUiIntent(); // 事件已送达:消费壳的待取副本,防下次整页加载重放
      openSettings();
    });
    Promise.all([listModels().catch(() => [] as ModelInfo[]), refreshSessions()])
      .then(([ms, metas]) => {
        setModels(ms);
        setNewModel(ms.find((m) => m.default)?.name ?? "");
        const last = lastSessionId();
        const meta = metas.find((m) => m.id === last);
        if (meta) openSession(meta);
        if (ms.length === 0 && inDesktopShell()) setView("settings");
        // 托盘"设置"兜底:页面未就绪时事件会丢(壳侧发后不管),意图落在壳的
        // 待取状态,这里补取;启动期间事件先到、又被上面恢复会话覆盖的同理。
        void takeUiIntent().then((intent) => {
          if (intent === "open-settings" || settingsRequestedRef.current) openSettings();
        });
      })
      .catch((e) => session.notify("无法连接服务: " + (e instanceof Error ? e.message : e)));
    if (inDesktopShell()) {
      void getHostInfo().then((info) => setHostVersion(info?.version ?? null));
      updateCheck()
        .then(setUpdate)
        .catch(() => {}); // 静默:自动检查失败不打扰
    }
    return () => offSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 新任务默认工作目录:沿用最近会话的目录,没有会话则用 ~/MonkeyCode(用户改过则不再跟随)
  const lastDir =
    [...sessions].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0]?.workdir ?? "";
  useEffect(() => {
    if (dirTouchedRef.current) return;
    setNewDir(lastDir || DEFAULT_DIR);
  }, [lastDir]);

  const showDiff = async (path: string) => {
    setViewer({ path, kind: "diff", text: "加载中…" });
    try {
      const r = await session.fileDiff(path);
      setViewer({ path, kind: "diff", text: r.error ? "✗ " + r.error : r.result?.diff || "(无差异)" });
    } catch (e) {
      setViewer({ path, kind: "diff", text: "✗ " + (e instanceof Error ? e.message : e) });
    }
  };

  const showFile = async (path: string) => {
    setViewer({ path, kind: "plain", text: "加载中…" });
    try {
      const r = await session.readFile(path);
      if (r.error) {
        setViewer({ path, kind: "plain", text: "✗ " + r.error });
        return;
      }
      const content = r.result?.content ?? "";
      if (!content) setViewer({ path, kind: "plain", text: "(空文件)" });
      else if (content.includes("\0")) setViewer({ path, kind: "plain", text: "二进制文件,不支持预览" });
      else setViewer({ path, kind: "code", text: content });
    } catch (e) {
      setViewer({ path, kind: "plain", text: "✗ " + (e instanceof Error ? e.message : e) });
    }
  };

  // 拉取目录子项(空串 = 工作区根,内核已按目录在前排好);已缓存/在途则跳过
  const loadChildren = async (dir: string, force = false) => {
    if (!force && (tree.has(dir) || loadingDirs.has(dir))) return;
    setLoadingDirs((s) => new Set(s).add(dir));
    try {
      const r = await session.listFiles(dir);
      if (r.error) setFsErr(r.error);
      else setTree((m) => new Map(m).set(dir, r.result ?? []));
    } catch (e) {
      setFsErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDirs((s) => {
        const n = new Set(s);
        n.delete(dir);
        return n;
      });
    }
  };

  // 展开/收起文件夹(展开时懒加载子项,已缓存的即时展开)
  const toggleDir = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void loadChildren(dir);
      }
      return next;
    });
  };

  // 拖拽跟踪:mousedown 后接管 move/up,期间锁定光标与选区,松手时收尾
  const trackPointer = (cursor: string, onMove: (ev: MouseEvent) => void, onDone: () => void) => {
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onDone();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 抽屉左缘拖拽调宽,松手落盘记忆
  const startDrawerResize = (e: { preventDefault(): void }) => {
    e.preventDefault();
    setDragging(true);
    trackPointer(
      "col-resize",
      (ev) => {
        const max = Math.round(window.innerWidth * 0.9);
        setDrawerW(Math.min(Math.max(window.innerWidth - ev.clientX, 420), max));
      },
      () => {
        setDragging(false);
        setDrawerW((w) => {
          localStorage.setItem("mc.drawerWidth", String(w));
          return w;
        });
      },
    );
  };

  // 列表/预览分栏拖拽:以列表顶为基准算高度,预览区至少保留 160px
  const startSplitResize = (e: { preventDefault(): void }) => {
    e.preventDefault();
    const top = listRef.current?.getBoundingClientRect().top ?? 0;
    setSplitDragging(true);
    trackPointer(
      "row-resize",
      (ev) => {
        const max = Math.max(window.innerHeight - top - 160, 80);
        setSplitH(Math.min(Math.max(ev.clientY - top, 80), max));
      },
      () => {
        setSplitDragging(false);
        setSplitH((h) => {
          localStorage.setItem("mc.drawerSplit", String(h));
          return h;
        });
      },
    );
  };

  // 工作区相对路径 → 绝对路径(Windows workdir 为反斜杠时统一分隔符)
  const absPath = (rel: string) => {
    const wd = currentMeta?.workdir ?? "";
    if (!rel) return wd;
    const sep = wd.includes("\\") ? "\\" : "/";
    const tail = sep === "\\" ? rel.split("/").join(sep) : rel;
    return wd.endsWith(sep) ? wd + tail : wd + sep + tail;
  };

  // 在系统文件管理器中定位:内核在本机执行(open/explorer/xdg-open),
  // 壳内与浏览器模式行为一致;失败时复制绝对路径兜底
  const revealPath = async (rel: string) => {
    try {
      const r = await session.reveal(rel);
      if (r.error) throw new Error(r.error);
    } catch (e) {
      const p = absPath(rel);
      try {
        await navigator.clipboard.writeText(p);
        session.notify("⚠ 无法打开文件夹,已复制路径: " + p);
      } catch {
        session.notify("⚠ 无法打开文件夹: " + (e instanceof Error ? e.message : String(e)));
      }
    }
  };

  // 打开抽屉(可指定视角:聊天区徽标直达「改动」);两个 tab 的数据并行刷新
  const openDrawer = (tab: "files" | "changes" = "files") => {
    setDrawerOpen(true);
    setDrawerTab(tab);
    setViewer(null);
    setTree(new Map());
    setExpanded(new Set());
    setFsErr("");
    void session.refreshChanges();
    void loadChildren("", true);
  };

  const createTask = async (createDir = false) => {
    const dir = newDir.trim();
    if (!dir || busy) return;
    setBusy(true);
    setNewErr("");
    setOfferCreate(false);
    try {
      // 自有默认目录静默创建;用户自填的目录不存在仍走确认流程
      const meta = await createSession(dir, newModel, createDir || dir === DEFAULT_DIR);
      const first = newText.trim();
      setNewText("");
      await refreshSessions();
      openSession(meta, first || undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNewErr("创建失败: " + msg);
      if (msg.includes("目录不存在")) setOfferCreate(true);
    } finally {
      setBusy(false);
    }
  };

  // ===== 派生状态 =====
  const currentMeta = sessions.find((m) => m.id === session.id);
  const currentModel = session.model || models.find((m) => m.default)?.name || "";
  const menuModels: ModelInfo[] =
    session.model && !models.some((m) => m.name === session.model)
      ? [...models, { name: session.model, default: false }] // 下线模型兜底,无 source 归「自定义」组
      : models;
  const openPerm = [...session.chat.items].reverse().find((it) => it.kind === "perm" && it.state === "open") as
    | Extract<LogItem, { kind: "perm" }>
    | undefined;
  const isNewView = view === "new" || session.id === null;
  const changes = session.changes;
  // 文件抽屉的改动标注:路径 → 状态;目录行显示其下改动计数
  const changeMap = new Map((changes ?? []).map((c) => [c.path, c.status] as const));
  const changedUnder = (dir: string) => (changes ?? []).filter((c) => c.path.startsWith(dir + "/")).length;

  // 树形文件列表:展开的文件夹原地铺开子项,层级用缩进表达(每层 16px)。
  // 本层已删除的文件以划线幽灵行缀在末尾;子项懒加载,加载中给骨架行。
  const renderTree = (dir: string, depth: number): ReactNode[] => {
    const pad = 10 + depth * 16;
    const rows: ReactNode[] = [];
    const items = tree.get(dir);
    if (!items) {
      if (loadingDirs.has(dir)) {
        for (let i = 0; i < (dir === "" ? 4 : 1); i++) {
          rows.push(
            <div key={`ld:${dir}:${i}`} style={{ ...fileRow, cursor: "default", paddingLeft: pad + 21 }}>
              <span className="skeleton" style={{ width: 14, height: 14, borderRadius: 4 }} />
              <span className="skeleton" style={{ height: 10, width: 110 + (i % 3) * 52 }} />
            </div>,
          );
        }
      }
      return rows;
    }
    for (const en of items) {
      const st = en.is_dir ? undefined : changeMap.get(en.path);
      const kind = st ? CHANGE_KIND[st] : undefined;
      const subCount = en.is_dir ? changedUnder(en.path) : 0;
      const open = en.is_dir && expanded.has(en.path);
      const active = viewer?.path === en.path;
      rows.push(
        <div
          key={en.path}
          className={active ? undefined : "hv"}
          title={en.path}
          onClick={() => (en.is_dir ? toggleDir(en.path) : kind ? void showDiff(en.path) : void showFile(en.path))}
          style={{ ...fileRow, paddingLeft: pad, background: active ? "var(--hov)" : "transparent" }}
        >
          <span style={{ width: 12, flex: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {en.is_dir && (
              <IconChevronRight
                size={8}
                color="var(--t5)"
                style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s ease" }}
              />
            )}
          </span>
          {en.is_dir ? <IconFolder size={14} color="var(--acc)" /> : <IconFile color={kind ? kind.fg : "var(--t4)"} />}
          <span className="ellipsis" style={{ flex: 1, fontSize: 12.5, color: "var(--t1)" }}>
            {en.name}
          </span>
          {en.is_dir && subCount > 0 && (
            <span style={{ ...changeTag, color: "var(--acc)", background: "var(--accBg)" }}>{subCount} 处改动</span>
          )}
          {!en.is_dir && kind && <span style={{ ...changeTag, color: kind.fg, background: kind.bg }}>{kind.text}</span>}
          {!en.is_dir && !kind && (
            <span style={{ flex: "none", width: 60, textAlign: "right", font: "10.5px " + MONO, color: "var(--t6)" }}>
              {fmtSize(en.size)}
            </span>
          )}
        </div>,
      );
      if (open) rows.push(...renderTree(en.path, depth + 1));
    }
    const ghosts = (changes ?? []).filter(
      (c) => c.status === "D" && (c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : "") === dir,
    );
    for (const c of ghosts) {
      rows.push(
        <div key={"del:" + c.path} className="hv" title={c.path} onClick={() => void showDiff(c.path)} style={{ ...fileRow, paddingLeft: pad }}>
          <span style={{ width: 12, flex: "none" }} />
          <IconFile color={CHANGE_KIND.D.fg} />
          <span className="ellipsis" style={{ flex: 1, fontSize: 12.5, color: "var(--t5)", textDecoration: "line-through" }}>
            {basename(c.path)}
          </span>
          <span style={{ ...changeTag, color: CHANGE_KIND.D.fg, background: CHANGE_KIND.D.bg }}>{CHANGE_KIND.D.text}</span>
        </div>,
      );
    }
    if (items.length === 0 && ghosts.length === 0) {
      if (dir === "") {
        rows.push(
          <div key="empty-root" style={{ padding: "36px 0 28px", display: "flex", flexDirection: "column", alignItems: "center", gap: 9 }}>
            <IconFolder size={22} color="var(--t6)" />
            <span style={{ fontSize: 12, color: "var(--t5)" }}>工作区是空的</span>
          </div>,
        );
      } else {
        rows.push(
          <div key={"empty:" + dir} style={{ ...fileRow, cursor: "default", paddingLeft: pad + 21 }}>
            <span style={{ fontSize: 11.5, color: "var(--t6)" }}>(空)</span>
          </div>,
        );
      }
    }
    return rows;
  };
  const recentDirs = (() => {
    const dirs = groupByProject(sessions.filter((m) => !m.archived)).map((g) => g.dir);
    if (!dirs.includes(newDir)) dirs.unshift(newDir);
    return dirs.slice(0, 6);
  })();

  // ===== 全局快捷键:⇧⇥ 权限模式、⏎/esc 应答审批、esc 关闭浮层 =====
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.shiftKey && view === "session" && session.id) {
        e.preventDefault();
        void session.toggleYolo();
        return;
      }
      if (e.key === "Escape") {
        if (childView) return setChildView(null);
        if (drawerOpen) {
          if (viewer) return setViewer(null); // 先关文件查看器,再关抽屉
          return setDrawerOpen(false);
        }
        // 输入态 Esc(清空/取消输入法/关自动补全)只收敛焦点,不触发视图级动作
        // ——尤其不能当作审批拒绝(deny 不可逆);先 blur,想应答再按一次
        const t = e.target as HTMLElement | null;
        const typing = !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT");
        if (view === "settings") {
          if (typing) return t.blur();
          return closeSettings();
        }
        if (view === "cloud") {
          // xterm 的隐藏 textarea:Esc 要透传给云端 shell(vim 等),不 blur 不关视图
          if (t?.closest?.(".xterm")) return;
          if (typing) return t.blur();
          return closeCloudTask();
        }
        if (typing) return t.blur();
        // 仅会话视图响应审批快捷键:新任务/云端视图不误拒背景会话的审批(Enter 同守卫)
        if (openPerm && view === "session" && !isNewView && !e.isComposing) session.answerPerm(openPerm.id, "deny");
        return;
      }
      if (e.key === "Enter" && !e.isComposing && openPerm && view === "session" && !isNewView) {
        const t = e.target as HTMLElement | null;
        const typing = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT");
        if (typing && session.input.trim()) return; // 正在输入内容,不当作审批
        e.preventDefault();
        session.answerPerm(openPerm.id, "allow");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100vw",
        height: "100vh",
        background: "var(--bg)",
        color: "var(--t1)",
        fontSize: 13,
        overflow: "hidden",
      }}
    >
      {/* Windows 壳:装饰栏已去除,自绘 36px 标题栏(拖拽 + 窗口按钮) */}
      {isWindowsShell() && <TitleBar />}
      {/* 引擎崩溃横幅:进程监视发现非正常退出时外显 + 一键重启
          (不外显的话会话流只会无限重连,表现为无提示的卡死) */}
      {engineCrash && (
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            background: "rgba(248,113,113,.1)",
            borderBottom: "1px solid var(--err)",
            fontSize: 12.5,
          }}
        >
          <span style={{ color: "var(--err)", fontWeight: 600, flex: "none" }}>⚠ {engineCrash.detail}</span>
          {engineCrash.log_tail && (
            <span className="ellipsis" style={{ color: "var(--t4)", fontSize: 11.5, minWidth: 0, font: `11.5px ${MONO}` }} title={engineCrash.log_tail}>
              {engineCrash.log_tail.trim().split("\n").pop()}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            className="hv-acc"
            disabled={engineRestarting}
            onClick={() => {
              setEngineRestarting(true);
              engineRestart()
                .then(() => location.reload())
                .catch((e) => {
                  setEngineRestarting(false);
                  setEngineCrash((c) => (c ? { ...c, detail: "重启失败: " + String(e) } : c));
                });
            }}
            style={{ height: 26, padding: "0 14px", border: "none", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600, background: "var(--acc)", color: "var(--onAcc)" }}
          >
            {engineRestarting ? "重启中…" : "重启引擎"}
          </button>
        </div>
      )}
      {/* 原根容器降级为内容行:改动抽屉的 absolute 以此为锚,始终盖在标题栏之下 */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
      {/* 设置态:设置视图自带左导航,主侧栏隐藏,设置占满主窗口(单侧栏) */}
      {view !== "settings" && (
        <Sidebar
          sessions={sessions}
          currentId={session.id}
          attention={attention}
          sessionActive={view === "session"}
          connected={session.connected}
          status={session.status}
          updateAvailable={!!update?.available}
          cloudTasks={cloudTasks}
          activeCloudId={view === "cloud" ? cloudTask?.id ?? null : null}
          cloudSyncing={cloudSyncing}
          onRefreshCloud={() => void syncCloud()}
          onOpenCloudTask={openCloudTask}
          onSelect={(m) => openSession(m)}
          onNewTask={(dir) => {
            if (dir) {
              dirTouchedRef.current = true;
              setNewDir(dir);
            }
            setNewErr("");
            setOfferCreate(false);
            setView("new");
          }}
          onOpenSettings={openSettings}
          onArchive={(m) => void archiveSession(m)}
          onDelete={(m) => void removeSession(m)}
          onRename={(m, title) => void renameSession(m, title)}
        />
      )}

      {/* ============ 主区 ============ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        {view === "settings" ? (
          <SettingsView
            onClose={closeSettings}
            onDirtyChange={(d) => {
              settingsDirty.current = d;
            }}
            hostVersion={hostVersion}
            update={update}
            onUpdateStatus={setUpdate}
          />
        ) : view === "cloud" && cloudTask ? (
          <CloudTaskView
            key={cloudTask.id}
            task={cloudTask}
            mcHost={mcHost}
            onTasksChanged={() => void syncCloud()}
          />
        ) : isNewView ? (
          <NewTaskView
            dir={newDir}
            recentDirs={recentDirs}
            text={newText}
            models={models}
            model={newModel}
            busy={busy}
            err={newErr}
            offerCreate={offerCreate}
            cloudReady={cloudSynced}
            onCloudCreated={(t) => {
              openCloudTask(t);
              void syncCloud();
            }}
            onDirChange={(d) => {
              dirTouchedRef.current = true;
              setNewDir(d);
              setNewErr("");
              setOfferCreate(false);
            }}
            onTextChange={setNewText}
            onModelChange={setNewModel}
            onCreate={(createDir) => void createTask(createDir)}
          />
        ) : (
          <ChatView
            meta={currentMeta}
            session={session}
            models={menuModels}
            currentModel={currentModel}
            onOpenDrawer={openDrawer}
            onOpenChild={setChildView}
            onArchive={() => currentMeta && void archiveSession(currentMeta)}
            onDelete={() => currentMeta && void removeSession(currentMeta)}
          />
        )}
      </div>

      {/* ============ 文件抽屉:工作区资源管理器(标注本轮改动) ============ */}
      {drawerOpen && (
        <>
          <div onClick={() => setDrawerOpen(false)} style={{ position: "absolute", inset: 0, background: "var(--scrim)", zIndex: 35 }} />
          <div
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              width: drawerW,
              maxWidth: "90vw",
              background: "var(--pop)",
              borderLeft: "1px solid var(--line)",
              boxShadow: "var(--shadow)",
              zIndex: 36,
              display: "flex",
              flexDirection: "column",
              animation: "mcslide .22s ease",
            }}
          >
            <div className={dragging ? "resize-handle dragging" : "resize-handle"} title="拖动调整宽度" onMouseDown={startDrawerResize} />
            {/* 头部:文件/改动下划线 tab(共用下方预览窗格),hairline 与主体分层 */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 16, padding: "6px 14px 0 20px", borderBottom: "1px solid var(--line2)", flex: "none", whiteSpace: "nowrap" }}>
              <button className={drawerTab === "files" ? undefined : "hv-t1"} style={drawerTabStyle(drawerTab === "files")} onClick={() => setDrawerTab("files")}>
                文件
              </button>
              <button className={drawerTab === "changes" ? undefined : "hv-t1"} style={drawerTabStyle(drawerTab === "changes")} onClick={() => setDrawerTab("changes")}>
                改动
                {changes && changes.length > 0 && (
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--acc)", background: "var(--accBg)", borderRadius: 8, padding: "0 6px", lineHeight: "15px" }}>
                    {changes.length}
                  </span>
                )}
              </button>
              <button className="hv2 icon-btn" title="关闭 (esc)" onClick={() => setDrawerOpen(false)} style={{ marginLeft: "auto", alignSelf: "center", width: 24, height: 24 }}>
                <IconX size={11} color="var(--t4)" />
              </button>
            </div>

            {(fsErr || session.changesErr) && (
              <div style={{ padding: "0 20px 8px", fontSize: 12, color: "var(--err)", flex: "none" }}>{fsErr || session.changesErr}</div>
            )}

            {/* 文件树 / 改动平铺:查看器打开时列表收拢为上方窗口 */}
            <div
              ref={listRef}
              style={{
                flex: viewer ? "none" : 1,
                height: viewer && splitH ? splitH : undefined,
                maxHeight: viewer ? (splitH ? "calc(100% - 190px)" : "38%") : undefined,
                overflowY: "auto",
                padding: "0 12px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 1,
              }}
            >
              {drawerTab === "changes" ? (
                <>
                  {[...(changes ?? [])]
                    .sort((a, b) => a.path.localeCompare(b.path))
                    .map((c) => {
                      const kind = CHANGE_KIND[c.status];
                      const sep = c.path.lastIndexOf("/");
                      const dir = sep > 0 ? c.path.slice(0, sep) : "";
                      const active = viewer?.path === c.path;
                      return (
                        <div
                          key={c.path}
                          className={active ? undefined : "hv"}
                          title={c.path}
                          onClick={() => void showDiff(c.path)}
                          style={{ ...fileRow, background: active ? "var(--hov)" : "transparent" }}
                        >
                          <IconFile color={kind.fg} />
                          <span
                            style={{
                              flex: "none",
                              fontSize: 12.5,
                              color: c.status === "D" ? "var(--t5)" : "var(--t1)",
                              textDecoration: c.status === "D" ? "line-through" : "none",
                            }}
                          >
                            {basename(c.path)}
                          </span>
                          <span className="ellipsis" style={{ flex: 1, fontSize: 11, fontFamily: MONO, color: "var(--t5)" }}>
                            {dir}
                          </span>
                          <span style={{ ...changeTag, color: kind.fg, background: kind.bg }}>{kind.text}</span>
                        </div>
                      );
                    })}
                  {(changes ?? []).length === 0 && (
                    <div style={{ padding: "36px 0 28px", display: "flex", flexDirection: "column", alignItems: "center", gap: 9 }}>
                      <IconFile size={22} color="var(--t6)" />
                      <span style={{ fontSize: 12, color: "var(--t5)" }}>本轮还没有文件改动</span>
                    </div>
                  )}
                </>
              ) : (
                <>{renderTree("", 0)}</>
              )}
            </div>

            {/* 文件查看器:改动文件看 diff,其余看内容;✕/esc 回到列表 */}
            {viewer && (
              <>
                <div
                  className={splitDragging ? "resize-handle-h dragging" : "resize-handle-h"}
                  title="拖动调整列表/预览高度"
                  onMouseDown={startSplitResize}
                  style={{ margin: "-5px 0 0" }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px 9px 20px", borderTop: "1px solid var(--line2)", background: "var(--bg)", flex: "none", whiteSpace: "nowrap", overflow: "hidden" }}>
                  <IconFile
                    color={changeMap.get(viewer.path) ? CHANGE_KIND[changeMap.get(viewer.path)!].fg : "var(--t4)"}
                  />
                  <span style={{ font: "600 12.5px " + MONO, color: "var(--t1)", flex: "none" }}>{basename(viewer.path)}</span>
                  <span className="ellipsis" style={{ fontSize: 11, fontFamily: MONO, color: "var(--t5)" }}>{viewer.path}</span>
                  {changeMap.get(viewer.path) && (
                    <span
                      style={{
                        ...changeTag,
                        color: CHANGE_KIND[changeMap.get(viewer.path)!].fg,
                        background: CHANGE_KIND[changeMap.get(viewer.path)!].bg,
                      }}
                    >
                      {CHANGE_KIND[changeMap.get(viewer.path)!].text}
                    </span>
                  )}
                  <button
                    className="hv"
                    title="在系统文件管理器中定位此文件(浏览器模式复制路径)"
                    onClick={() => void revealPath(viewer.path)}
                    style={{ marginLeft: "auto", flex: "none", height: 22, display: "flex", alignItems: "center", gap: 5, border: "none", background: "transparent", borderRadius: 6, padding: "0 8px", fontSize: 11.5, fontWeight: 600, color: "var(--t3)", cursor: "pointer" }}
                  >
                    <IconFolder size={11} color="var(--t4)" />
                    {IS_MAC ? "在访达中显示" : "打开所在文件夹"}
                  </button>
                  <button className="hv2 icon-btn" title="关闭,回到文件列表 (esc)" onClick={() => setViewer(null)} style={{ width: 22, height: 22 }}>
                    <IconX size={10} color="var(--t4)" />
                  </button>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "4px 0 20px" }}>
                  {viewer.kind === "diff" ? (
                    <DiffPanel text={viewer.text} />
                  ) : viewer.kind === "code" ? (
                    <CodeView path={viewer.path} text={viewer.text} />
                  ) : (
                    <pre style={{ margin: 0, padding: "10px 24px", font: "12px/1.9 " + MONO, color: "var(--t4)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {viewer.text}
                    </pre>
                  )}
                </div>
              </>
            )}

            {/* 底部动作栏:不给普通用户看路径(不认识),给任务语言 + 平台母语按钮;
                完整路径留在按钮悬停提示里给开发者 */}
            <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "9px 12px 9px 16px", borderTop: "1px solid var(--line2)", whiteSpace: "nowrap" }}>
              <span className="ellipsis" style={{ flex: 1, fontSize: 11.5, color: "var(--t5)" }}>
                这个任务的文件都保存在这台电脑上
              </span>
              <button
                className="hv-acc"
                title={currentMeta?.workdir ?? ""}
                onClick={() => void revealPath("")}
                style={{ flex: "none", height: 26, border: "none", background: "var(--acc)", color: "var(--onAcc)", borderRadius: 8, padding: "0 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, boxShadow: "var(--accSh)" }}
              >
                <IconFolder size={12} color="var(--onAcc)" />
                {IS_MAC ? "在访达中打开" : "打开文件夹"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ============ 子代理会话回放 ============ */}
      {childView && (
        <div
          onClick={() => setChildView(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "var(--scrim2)",
            zIndex: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(860px, 92vw)",
              maxHeight: "84vh",
              background: "var(--pop)",
              border: "1px solid var(--line)",
              borderRadius: 16,
              boxShadow: "var(--shadowLg)",
              padding: "20px 24px",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              animation: "mcin .2s ease",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12, whiteSpace: "nowrap" }}>
              <span className="ellipsis" style={{ fontSize: 14, fontWeight: 700 }}>
                子代理会话 {childView}
              </span>
              <button className="hv2 icon-btn" onClick={() => setChildView(null)} style={{ marginLeft: "auto", width: 24, height: 24 }}>
                <IconX size={11} color="var(--t4)" />
              </button>
            </div>
            <SessionViewer id={childView} workdir={currentMeta?.workdir} />
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

/** 子会话只读回放/跟看:复用同一 WS 协议(服务端对子会话走观察者路径) */
function SessionViewer({ id, workdir }: { id: string; workdir?: string }) {
  const [chat, setChat] = useState<ChatState>(initialChat);
  const [status, setStatus] = useState("连接中…");

  useEffect(() => {
    const conn = connect(id, {
      onFrames: (batch) => setChat((s) => reduceBatch(s, batch)),
      onStatus: (text) => setStatus(text),
    });
    return () => conn.close();
  }, [id]);

  return (
    <div style={{ overflowY: "auto", flex: 1, paddingRight: 6, display: "flex", flexDirection: "column", gap: 14, lineHeight: 1.8 }}>
      <div style={{ color: "var(--t4)", fontSize: 12 }}>{status}</div>
      <LogList items={chat.items} onPermAnswer={() => {}} workdir={workdir} />
    </div>
  );
}
