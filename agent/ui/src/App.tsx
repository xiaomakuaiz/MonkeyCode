// 布局与交互对照「MonkeyCode 原型(离线版)」实现:侧栏(搜索 + 扁平会话列表)、
// 新建任务视图、会话视图(思考/工具/审批/运行条/排队/改动条)、改动抽屉。
// 样式值取自原型内联样式;协议层(client/reduce)不变。
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  b64encode,
  connect,
  createSession,
  deleteSession,
  inDesktopShell,
  listModels,
  listSessions,
  onHostEvent,
  pickDirectory,
  setSessionArchived,
  type Conn,
} from "./client";
import { DiffPanel, LogList, MONO, SessionRow } from "./components";
import logoUrl from "./logo.png";
import { SettingsView } from "./settings";
import { answerPerm, initialChat, reduceBatch, type ChatState } from "./reduce";
import type { FileChange, Frame, ModelInfo, SessionMeta } from "./types";

// 输入法(IME)组合态的 Enter 只是确认候选词,不能当作提交。Chromium 上该 keydown
// 的 isComposing 为 true 即可拦截;但 WebKit(macOS 壳的 WKWebView)顺序相反:
// compositionend 先于 keydown 触发且 isComposing 已复位。故再记录组合结束时刻,
// 紧随其后的 Enter(同一次按键,时间差远小于人手连按)一律视为选字确认。
let imeEndedAt = -Infinity;
const markImeEnd = (e: { timeStamp: number }) => {
  imeEndedAt = e.timeStamp;
};
const isImeEnter = (e: { timeStamp: number; nativeEvent: { isComposing: boolean } }) =>
  e.nativeEvent.isComposing || e.timeStamp - imeEndedAt < 100;

const fmtK = (n: number) =>
  n >= 1_000_000 ? Math.round(n / 100_000) / 10 + "M" : n >= 1000 ? Math.round(n / 100) / 10 + "k" : String(n);

const basename = (p: string) => p.replace(/[\/\\]+$/, "").split(/[\/\\]/).pop() || p;

/** 首启默认工作目录(内核解析 ~,不存在时自动创建);老用户默认沿用最近会话的目录 */
const DEFAULT_DIR = "~/MonkeyCode";

interface ProjectGroup {
  dir: string;
  name: string;
  latest: string;
  items: SessionMeta[];
}

/** 会话按项目(工作区目录)分组;worktree 会话归属原仓库目录 */
function groupByProject(sessions: SessionMeta[]): ProjectGroup[] {
  const map = new Map<string, SessionMeta[]>();
  for (const m of sessions) {
    const dir = m.worktree?.repo || m.workdir;
    const list = map.get(dir);
    if (list) list.push(m);
    else map.set(dir, [m]);
  }
  const groups = [...map.entries()].map(([dir, items]) => {
    items.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return {
      dir,
      name: dir.replace(/[\/\\]+$/, "").split(/[\/\\]/).pop() || dir,
      latest: items[0]?.updated_at ?? "",
      items,
    };
  });
  groups.sort((a, b) => b.latest.localeCompare(a.latest));
  return groups;
}

/** 720px 居中列(对话流 / 改动条 / 输入框共用的宽度约定) */
const COL: CSSProperties = { width: 720, maxWidth: "100%" };

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [view, setView] = useState<"new" | "session" | "settings">("new");
  const [chat, setChat] = useState<ChatState>(initialChat);
  const [status, setStatus] = useState("未连接");
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const [changesErr, setChangesErr] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  const [input, setInput] = useState("");
  const [queued, setQueued] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [childView, setChildView] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sessionModel, setSessionModel] = useState("");
  const [yolo, setYolo] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hoverGrp, setHoverGrp] = useState<string | null>(null); // 悬停的分组(CSS :hover 在 WKWebView 不可靠,用状态控制)
  // 新建任务视图
  const [newDir, setNewDir] = useState(DEFAULT_DIR);
  const [editDir, setEditDir] = useState(false);
  const [newModel, setNewModel] = useState("");
  const [newText, setNewText] = useState("");
  const [newErr, setNewErr] = useState("");
  const [offerCreate, setOfferCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("mc.collapsedGroups") || "[]") as string[]);
    } catch {
      return new Set();
    }
  });

  // 「已归档」组展开状态(默认收起)
  const [archivedOpen, setArchivedOpen] = useState(() => localStorage.getItem("mc.archivedOpen") === "1");
  const toggleArchived = () => {
    setArchivedOpen((o) => {
      localStorage.setItem("mc.archivedOpen", o ? "0" : "1");
      return !o;
    });
  };

  const toggleGroup = (dir: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      localStorage.setItem("mc.collapsedGroups", JSON.stringify([...next]));
      return next;
    });
  };

  const connRef = useRef<Conn | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pinnedRef = useRef(true); // 用户是否停留在底部(自动跟随滚动)
  const pendingMsgRef = useRef<string | null>(null); // 新建会话时输入的首个任务,连上后发出
  const dirTouchedRef = useRef(false); // 用户改过工作目录后不再跟随默认值

  const refreshSessions = useCallback(async () => {
    const metas = await listSessions();
    setSessions(metas);
    return metas;
  }, []);

  const refreshChanges = useCallback(async (): Promise<FileChange[]> => {
    const conn = connRef.current;
    if (!conn) return [];
    try {
      const r = await conn.call<{ result?: FileChange[]; error?: string }>("repo_file_changes");
      if (r.error) {
        setChangesErr(r.error);
        setChanges([]);
        return [];
      }
      setChangesErr("");
      const list = r.result ?? [];
      setChanges(list);
      return list;
    } catch (e) {
      setChangesErr(e instanceof Error ? e.message : String(e));
      setChanges([]);
      return [];
    }
  }, []);

  // 归档/取消归档:仅列表位置变化,当前打开的会话不强制关闭
  const archiveSession = async (m: SessionMeta) => {
    try {
      await setSessionArchived(m.id, !m.archived);
      await refreshSessions();
    } catch (e) {
      setStatus("⚠ 归档失败: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // 删除会话;若删的是当前打开的会话,按 openSession 反向复位回新建任务视图
  const removeSession = async (m: SessionMeta) => {
    try {
      await deleteSession(m.id);
    } catch (e) {
      setStatus("⚠ 删除失败: " + (e instanceof Error ? e.message : String(e)));
      return;
    }
    if (m.id === currentId) {
      connRef.current?.close();
      connRef.current = null;
      setCurrentId(null);
      setView("new");
      setChat(initialChat);
      setChanges(null);
      setChangesErr("");
      setDrawerOpen(false);
      setDiff(null);
      setMenuOpen(false);
      setQueued(null);
      setSessionModel("");
      setYolo(false);
      setStatus("未连接");
      localStorage.removeItem("mc.lastSession");
    }
    void refreshSessions();
  };

  const openSession = useCallback(
    (id: string, model?: string, mode?: string) => {
      connRef.current?.close();
      setCurrentId(id);
      setView("session");
      setChat(initialChat);
      setChanges(null);
      setChangesErr("");
      setDrawerOpen(false);
      setDiff(null);
      setMenuOpen(false);
      setQueued(null);
      setSessionModel(model ?? "");
      setYolo(mode === "yolo");
      localStorage.setItem("mc.lastSession", id);
      connRef.current = connect(id, {
        onFrames: (batch: Frame[]) => setChat((s) => reduceBatch(s, batch)),
        onStatus: (text) => setStatus(text),
      });
      void refreshSessions();
    },
    [refreshSessions],
  );

  // 启动:拉模型清单 + 恢复上次会话;桌面壳内无模型(首启/被清空)直接进设置向导。
  // 另订阅壳的托盘"设置"事件。
  useEffect(() => {
    const offSettings = onHostEvent("open-settings", () => setView("settings"));
    Promise.all([listModels().catch(() => [] as ModelInfo[]), refreshSessions()])
      .then(([ms, metas]) => {
        setModels(ms);
        setNewModel(ms.find((m) => m.default)?.name ?? "");
        const last = localStorage.getItem("mc.lastSession");
        const meta = metas.find((m) => m.id === last);
        if (meta) openSession(meta.id, meta.model, meta.mode);
        if (ms.length === 0 && inDesktopShell()) setView("settings");
      })
      .catch((e) => setStatus("无法连接服务: " + (e instanceof Error ? e.message : e)));
    return () => {
      offSettings();
      connRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // model_update 帧回写当前模型显示
  useEffect(() => {
    if (chat.model) setSessionModel(chat.model);
  }, [chat.model]);

  // permission_mode_update 帧回写 YOLO 开关(回放/多客户端同步)
  useEffect(() => {
    if (chat.permMode) setYolo(chat.permMode === "yolo");
  }, [chat.permMode]);

  // 新任务默认工作目录:沿用最近会话的目录,没有会话则用 ~/MonkeyCode(用户改过则不再跟随)
  const lastDir =
    [...sessions].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0]?.workdir ?? "";
  useEffect(() => {
    if (dirTouchedRef.current) return;
    setNewDir(lastDir || DEFAULT_DIR);
  }, [lastDir]);

  // 连接就绪:拉改动计数;若新建会话时带了首个任务,此刻发出
  const connected = status.startsWith("已连接");
  useEffect(() => {
    if (!connected) return;
    void refreshChanges();
    const pending = pendingMsgRef.current;
    if (pending && connRef.current?.send("user-input", { content: b64encode(pending) })) {
      pendingMsgRef.current = null;
    }
  }, [connected, refreshChanges]);

  // 本轮结束:刷新改动计数与会话列表
  useEffect(() => {
    if (!chat.turnEnded) return;
    setChat((s) => ({ ...s, turnEnded: false }));
    void refreshChanges();
    void refreshSessions();
  }, [chat.turnEnded, refreshChanges, refreshSessions]);

  // 排队的输入:运行结束后自动发送(原型 queued 交互)
  useEffect(() => {
    if (chat.running || !queued) return;
    if (connRef.current?.send("user-input", { content: b64encode(queued) })) setQueued(null);
  }, [chat.running, queued]);

  // 自动滚动(仅当用户停留在底部)
  useEffect(() => {
    const el = logRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [chat.items, chat.running]);

  // 输入框随内容自适应高度
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const send = () => {
    const text = input.trim();
    if (!text || !connRef.current) return;
    if (chat.running) {
      // 运行中先排队,本轮结束自动发送(可点 ✕ 取消)
      setQueued(text);
      setInput("");
      return;
    }
    if (connRef.current.send("user-input", { content: b64encode(text) })) setInput("");
  };

  const onPermAnswer = (id: string, action: "allow" | "always" | "persist" | "deny") => {
    const approved = action !== "deny";
    if (
      connRef.current?.send("permission-resp", {
        id,
        approved,
        remember: action === "always" || action === "persist",
        persist: action === "persist",
      })
    ) {
      setChat((s) => answerPerm(s, id, approved));
    }
  };

  const switchModel = async (name: string) => {
    setMenuOpen(false);
    if (!connRef.current || !name || name === sessionModel) return;
    try {
      const r = await connRef.current.call<{ result?: { model: string }; error?: string }>(
        "session_set_model",
        { model: name },
      );
      if (r.error) {
        setStatus("⚠ 切换模型失败: " + r.error);
        return;
      }
      setSessionModel(name); // model_update 帧也会到达并渲染系统行
      void refreshSessions();
    } catch (e) {
      setStatus("⚠ 切换模型失败: " + (e instanceof Error ? e.message : e));
    }
  };

  const toggleYolo = async () => {
    if (!connRef.current) return;
    const prev = yolo;
    const next = prev ? "default" : "yolo";
    setYolo(!prev); // 乐观回写,失败回滚
    try {
      const r = await connRef.current.call<{ result?: { mode: string }; error?: string }>(
        "session_set_mode",
        { mode: next },
      );
      if (r.error) {
        setYolo(prev);
        setStatus("⚠ 切换权限模式失败: " + r.error);
      }
    } catch (e) {
      setYolo(prev);
      setStatus("⚠ 切换权限模式失败: " + (e instanceof Error ? e.message : e));
    }
  };

  const showDiff = async (path: string) => {
    setDiff({ path, text: "加载中…" });
    try {
      const r = await connRef.current!.call<{ result?: { diff?: string }; error?: string }>("repo_file_diff", {
        path,
      });
      setDiff({ path, text: r.error ? "✗ " + r.error : r.result?.diff || "(无差异)" });
    } catch (e) {
      setDiff({ path, text: "✗ " + (e instanceof Error ? e.message : e) });
    }
  };

  const openDrawer = () => {
    setDrawerOpen(true);
    void refreshChanges().then((list) => {
      if (list.length) void showDiff(list[0].path);
      else setDiff(null);
    });
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
      if (first) pendingMsgRef.current = first;
      setNewText("");
      await refreshSessions();
      openSession(meta.id, meta.model, meta.mode);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNewErr("创建失败: " + msg);
      if (msg.includes("目录不存在")) setOfferCreate(true);
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const dir = await pickDirectory();
    if (dir) {
      dirTouchedRef.current = true;
      setNewDir(dir);
      setNewErr("");
      setOfferCreate(false);
    }
  };

  // ===== 派生状态 =====
  const currentMeta = sessions.find((m) => m.id === currentId);
  const currentModel = sessionModel || models.find((m) => m.default)?.name || "";
  const menuModels: ModelInfo[] =
    sessionModel && !models.some((m) => m.name === sessionModel)
      ? [...models, { name: sessionModel, default: false }]
      : models;
  const usage = chat.usage;
  const openPerm = [...chat.items].reverse().find((it) => it.kind === "perm" && it.state === "open") as
    | Extract<(typeof chat.items)[number], { kind: "perm" }>
    | undefined;
  const anyToolRunning = chat.items.some((it) => it.kind === "tool" && it.status === "run");
  const runningLabel = openPerm ? "等待权限确认" : anyToolRunning ? "执行中" : "思考中";
  const roundNo = Math.max(1, chat.items.filter((it) => it.kind === "user").length);

  const q = query.trim().toLowerCase();
  const filtered = (
    q
      ? sessions.filter(
          (m) => (m.title || "").toLowerCase().includes(q) || m.workdir.toLowerCase().includes(q),
        )
      : sessions
  )
    .slice()
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  const list = filtered.filter((m) => !m.archived);
  const archivedList = filtered.filter((m) => m.archived);

  const isNewView = view === "new" || currentId === null;

  // ===== 全局快捷键:⌘K 搜索、⏎/esc 应答审批、esc 关闭浮层 =====
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "Tab" && e.shiftKey && view === "session" && currentId) {
        e.preventDefault();
        void toggleYolo();
        return;
      }
      if (e.key === "Escape") {
        if (menuOpen) return setMenuOpen(false);
        if (childView) return setChildView(null);
        if (drawerOpen) return setDrawerOpen(false);
        if (view === "settings") return setView(currentId ? "session" : "new");
        if (openPerm) onPermAnswer(openPerm.id, "deny");
        return;
      }
      if (e.key === "Enter" && !e.isComposing && openPerm && !isNewView) {
        const t = e.target as HTMLElement | null;
        const typing = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT");
        if (typing && input.trim()) return; // 正在输入内容,不当作审批
        e.preventDefault();
        onPermAnswer(openPerm.id, "allow");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <div
      style={{
        display: "flex",
        width: "100vw",
        height: "100vh",
        background: "var(--bg)",
        color: "var(--t2)",
        fontSize: 13.5,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* ============ 侧栏 ============ */}
      <div
        style={{
          width: 292,
          flex: "none",
          display: "flex",
          flexDirection: "column",
          background: "var(--side)",
          borderRight: "1px solid var(--line)",
          minWidth: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 18px 14px" }}>
          <img
            src={logoUrl}
            alt=""
            draggable={false}
            style={{ width: 28, height: 28, borderRadius: 9, flex: "none" }}
          />
          <div style={{ fontWeight: 700, fontSize: 14.5, color: "var(--t1)", letterSpacing: "-.01em" }}>
            MonkeyCode
          </div>
        </div>
        <div style={{ padding: "0 14px 12px" }}>
          <div
            style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--card)", borderRadius: 9, padding: "0 11px" }}
          >
            <span style={{ color: "var(--t4)", fontSize: 12 }}>⌕</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索会话"
              style={{
                flex: 1,
                background: "none",
                border: "none",
                outline: "none",
                color: "var(--t1)",
                fontSize: 12.5,
                padding: "8px 0",
                minWidth: 0,
              }}
            />
            <span style={{ font: "10px " + MONO, color: "var(--t5)" }}>⌘K</span>
          </div>
        </div>

        {/* 云端任务区:执行后端未上线,常驻原型的空态(有后端后在此渲染任务卡) */}
        <div style={{ padding: "0 14px", flex: "none" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "0 4px 8px", whiteSpace: "nowrap" }}>
            <span style={{ font: "600 10.5px system-ui", color: "var(--t4)", letterSpacing: ".1em" }}>云端任务</span>
            <span style={{ marginLeft: 6, font: "400 10.5px system-ui", color: "var(--t5)" }}>跑在服务器</span>
          </div>
          <div
            style={{
              border: "1px dashed var(--line)",
              borderRadius: 11,
              padding: "14px 13px",
              fontSize: 11.5,
              color: "var(--t5)",
              lineHeight: 1.7,
            }}
          >
            还没有云端任务。长任务可以派发到服务器上跑,关掉客户端也会继续。
          </div>
        </div>

        {/* 表头在滚动容器之外,滚动列表时恒定可见;右侧为通用的新建任务入口 */}
        <div style={{ padding: "16px 14px 0", flex: "none" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "0 4px 6px", whiteSpace: "nowrap" }}>
            <span style={{ font: "600 10.5px system-ui", color: "var(--t4)", letterSpacing: ".1em" }}>本地会话</span>
            <span style={{ marginLeft: 6, font: "400 10.5px system-ui", color: "var(--t5)" }}>这台电脑</span>
            <span
              className="hv-cardh"
              title="新建任务"
              onClick={() => {
                setView("new");
                setMenuOpen(false);
              }}
              style={{
                marginLeft: "auto",
                width: 20,
                height: 20,
                borderRadius: 6,
                background: "var(--card2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                color: "var(--t3)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              +
            </span>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 14px" }}>
          {sessions.length === 0 && (
            <div
              style={{
                border: "1px dashed var(--line)",
                borderRadius: 11,
                padding: "14px 13px",
                fontSize: 11.5,
                color: "var(--t5)",
                lineHeight: 1.7,
              }}
            >
              还没有会话。在右侧输入第一个任务开始。
            </div>
          )}
          {sessions.length > 0 && filtered.length === 0 && (
            <div style={{ padding: "2px 4px", fontSize: 11.5, color: "var(--t5)", lineHeight: 1.7 }}>
              没有匹配「{query.trim()}」的会话。
            </div>
          )}
          {groupByProject(list).map((g) => (
            <div key={g.dir} style={{ marginBottom: 12 }}>
              <div
                title={g.dir}
                onClick={() => toggleGroup(g.dir)}
                onMouseEnter={() => setHoverGrp(g.dir)}
                onMouseLeave={() => setHoverGrp(null)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "5px 6px 5px 4px",
                  cursor: "pointer",
                  userSelect: "none",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                <span style={{ width: 10, flex: "none", fontSize: 9, color: "var(--t5)" }}>
                  {collapsed.has(g.dir) ? "▶" : "▼"}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--t3)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {g.name}
                </span>
                <span style={{ fontSize: 10.5, color: "var(--t5)" }}>{g.items.length}</span>
                <span
                  className="hv-t1"
                  title={"在 " + g.dir + " 新建会话"}
                  onClick={(e) => {
                    e.stopPropagation();
                    dirTouchedRef.current = true;
                    setNewDir(g.dir);
                    setEditDir(false);
                    setView("new");
                  }}
                  style={{
                    marginLeft: "auto",
                    width: 20,
                    height: 20,
                    borderRadius: 6,
                    background: "var(--card2)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                    color: "var(--t3)",
                    cursor: "pointer",
                    visibility: hoverGrp === g.dir ? "visible" : "hidden",
                  }}
                >
                  +
                </span>
              </div>
              {!collapsed.has(g.dir) && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    marginLeft: 8,
                    paddingLeft: 7,
                    borderLeft: "1px solid var(--line)",
                  }}
                >
                  {g.items.map((m) => (
                    <SessionRow
                      key={m.id}
                      meta={m}
                      active={m.id === currentId && view === "session"}
                      onClick={() => openSession(m.id, m.model, m.mode)}
                      onArchive={() => void archiveSession(m)}
                      onDelete={() => void removeSession(m)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* ==== 已归档(默认收起;行内可取消归档/删除,点击照常回看)==== */}
          {archivedList.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div
                onClick={toggleArchived}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "5px 6px 5px 4px",
                  cursor: "pointer",
                  userSelect: "none",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ width: 10, flex: "none", fontSize: 9, color: "var(--t5)" }}>
                  {archivedOpen ? "▼" : "▶"}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--t5)" }}>已归档</span>
                <span style={{ fontSize: 10.5, color: "var(--t5)" }}>{archivedList.length}</span>
              </div>
              {archivedOpen && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    marginLeft: 8,
                    paddingLeft: 7,
                    borderLeft: "1px solid var(--line)",
                  }}
                >
                  {archivedList.map((m) => (
                    <SessionRow
                      key={m.id}
                      meta={m}
                      active={m.id === currentId && view === "session"}
                      onClick={() => openSession(m.id, m.model, m.mode)}
                      onArchive={() => void archiveSession(m)}
                      onDelete={() => void removeSession(m)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "14px 18px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--t4)",
            borderTop: "1px solid var(--line)",
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: connected ? "var(--ok)" : "var(--t5)",
              flex: "none",
            }}
          />
          <span title={status} style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {status}
          </span>
          <span
            className="hv-t1"
            title="设置"
            onClick={() => {
              setMenuOpen(false);
              setView("settings");
            }}
            style={{ marginLeft: "auto", cursor: "pointer", fontSize: 15 }}
          >
            ⚙
          </span>
        </div>
      </div>

      {/* ============ 主区 ============ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {view === "settings" ? (
          <SettingsView onClose={() => setView(currentId ? "session" : "new")} />
        ) : isNewView ? (
          /* ==== 新建任务视图 ==== */
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 22,
              animation: "mcin .25s ease",
              padding: "0 24px",
            }}
          >
            {sessions.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, marginBottom: 2 }}>
                <img
                  src={logoUrl}
                  alt=""
                  draggable={false}
                  style={{ width: 52, height: 52, borderRadius: 16 }}
                />
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--t1)", letterSpacing: "-.01em" }}>
                  把第一个任务交给 MonkeyCode
                </div>
                <div style={{ fontSize: 13, color: "var(--t4)", maxWidth: 460, textAlign: "center", lineHeight: 1.7 }}>
                  描述你想做的事。工作目录{" "}
                  <span style={{ font: "12px " + MONO, color: "var(--t3)" }}>{newDir || DEFAULT_DIR}</span>{" "}
                  已自动准备好,也可以换成你的项目目录。
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--t1)", letterSpacing: "-.01em" }}>
                开始一个新任务
              </div>
            )}

            {/* 环境双卡(原型:本地默认选中;云端执行后端未上线,置灰待开通) */}
            <div style={{ display: "flex", gap: 12, maxWidth: "100%", flexWrap: "wrap", justifyContent: "center" }}>
              <div
                style={{
                  width: 288,
                  border: "1px solid var(--amberBd)",
                  borderRadius: 16,
                  background: "var(--amberBg)",
                  padding: 20,
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 14, fontWeight: 700, color: "var(--amberT)", whiteSpace: "nowrap" }}
                >
                  ⌂ 本地
                  <span
                    style={{ marginLeft: "auto", fontSize: 10, background: "var(--amberBg)", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}
                  >
                    默认 ⏎
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.7, marginTop: 10 }}>
                  Agent 跑在这台电脑上,直接读写本地文件;每步权限逐一确认。
                </div>
                {editDir ? (
                  <input
                    value={newDir}
                    autoFocus
                    onChange={(e) => {
                      dirTouchedRef.current = true;
                      setNewDir(e.target.value);
                      setNewErr("");
                      setOfferCreate(false);
                    }}
                    onCompositionEnd={markImeEnd}
                    onKeyDown={(e) => e.key === "Enter" && !isImeEnter(e) && setEditDir(false)}
                    onBlur={() => setEditDir(false)}
                    placeholder="/home/you/dev/project"
                    style={{
                      width: "100%",
                      marginTop: 12,
                      background: "var(--codeBg)",
                      border: "1px solid var(--line)",
                      borderRadius: 9,
                      padding: "7px 10px",
                      font: "11px " + MONO,
                      color: "var(--t1)",
                      outline: "none",
                      minWidth: 0,
                      boxSizing: "border-box",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginTop: 12,
                      font: "11px " + MONO,
                      color: "var(--t5)",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                  >
                    <span style={{ color: "var(--t3)", overflow: "hidden", textOverflow: "ellipsis" }}>{newDir}</span>
                    {newDir === DEFAULT_DIR && <span style={{ flex: "none" }}>· 自动创建</span>}
                    <span
                      className="hv-t1"
                      onClick={() => setEditDir(true)}
                      style={{ marginLeft: "auto", cursor: "pointer", flex: "none", font: "12px system-ui" }}
                    >
                      更改
                    </span>
                    {inDesktopShell() && (
                      <span
                        className="hv-t1"
                        onClick={() => void browse()}
                        style={{ cursor: "pointer", flex: "none", font: "12px system-ui" }}
                      >
                        浏览…
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div
                style={{
                  width: 288,
                  border: "1px solid var(--line)",
                  borderRadius: 16,
                  background: "var(--card)",
                  padding: 20,
                  boxSizing: "border-box",
                  opacity: 0.7,
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 14, fontWeight: 700, color: "var(--t1)", whiteSpace: "nowrap" }}
                >
                  ☁ 云端
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10,
                      background: "var(--card2)",
                      color: "var(--t4)",
                      borderRadius: 5,
                      padding: "2px 8px",
                      fontWeight: 600,
                    }}
                  >
                    即将上线
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.7, marginTop: 10 }}>
                  Agent 跑在云上服务器,关掉客户端也继续;完成后打包改动回来审查。
                </div>
                <div style={{ display: "flex", font: "11px " + MONO, color: "var(--t5)", marginTop: 12, whiteSpace: "nowrap" }}>
                  需要连接平台<span style={{ marginLeft: "auto" }}>长任务推荐</span>
                </div>
              </div>
            </div>

            {newErr && (
              <div style={{ ...COL, width: 588, fontSize: 12, color: "var(--err)" }}>
                {newErr}
                {offerCreate && (
                  <span
                    className="hv-op"
                    onClick={() => void createTask(true)}
                    style={{ cursor: "pointer", color: "var(--amberT)", marginLeft: 8 }}
                  >
                    创建该目录并继续 →
                  </span>
                )}
              </div>
            )}

            <div
              style={{ ...COL, width: 588, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 16, padding: "13px 16px" }}
            >
              <input
                value={newText}
                autoFocus
                onChange={(e) => setNewText(e.target.value)}
                onCompositionEnd={markImeEnd}
                onKeyDown={(e) => e.key === "Enter" && !isImeEnter(e) && void createTask()}
                placeholder="描述任务…(可留空,先建会话)"
                style={{
                  width: "100%",
                  background: "none",
                  border: "none",
                  outline: "none",
                  color: "var(--t1)",
                  fontSize: 13.5,
                  boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 12, fontSize: 12, color: "var(--t5)" }}>
                {models.length > 1 ? (
                  <select
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    style={{ background: "transparent", border: "none", outline: "none", color: "var(--t4)", fontSize: 12, cursor: "pointer" }}
                  >
                    {models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                        {m.default ? "(默认)" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>{models[0]?.name ?? ""}</span>
                )}
                <div
                  className="hv-op"
                  onClick={() => void createTask()}
                  style={{
                    marginLeft: "auto",
                    width: 30,
                    height: 30,
                    borderRadius: 9,
                    background: "var(--amber)",
                    color: "var(--onAmber)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 800,
                    cursor: "pointer",
                    opacity: busy ? 0.5 : 1,
                  }}
                >
                  ↑
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ==== 会话视图 ==== */
          <>
            {/* header */}
            <div style={{ display: "flex", alignItems: "center", padding: "0 24px", height: 56, flex: "none" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: "var(--t1)",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {currentMeta?.title || "(未命名)"}
                </span>
                <span style={{ font: "400 11px " + MONO, color: "var(--t5)", overflow: "hidden", textOverflow: "ellipsis" }}>
                  ⌂ {currentMeta?.workdir ?? ""}
                </span>
              </div>

              <div
                className="hv-card"
                title="查看本轮文件改动"
                onClick={openDrawer}
                style={{
                  marginLeft: "auto",
                  padding: "6px 12px",
                  borderRadius: 8,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  fontSize: 12,
                  color: "var(--t3)",
                  flex: "none",
                  userSelect: "none",
                }}
              >
                <span style={{ color: "var(--amberT)" }}>⇄</span> 改动
                {changes && changes.length > 0 ? ` · ${changes.length}` : ""}
              </div>
            </div>
            <div style={{ height: 1, background: "var(--line)", margin: "0 24px", flex: "none" }} />

            {/* chat */}
            <div ref={logRef} onScroll={onLogScroll} style={{ flex: 1, overflowY: "auto", display: "flex", justifyContent: "center" }}>
              <div
                style={{
                  ...COL,
                  maxWidth: "calc(100% - 48px)",
                  padding: "28px 0 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 18,
                  lineHeight: 1.8,
                  height: "fit-content",
                }}
              >
                <LogList items={chat.items} onPermAnswer={onPermAnswer} onOpenChild={setChildView} />
              </div>
            </div>

            {/* running bar:钉在输入框上方(不随对话流滚动) */}
            {chat.running && (
              <div style={{ display: "flex", justifyContent: "center", padding: "0 24px 8px", flex: "none" }}>
                <div
                  style={{
                    ...COL,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 12.5,
                    color: "var(--t3)",
                    padding: "2px 0",
                    boxSizing: "border-box",
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      border: "2px solid var(--amber)",
                      borderTopColor: "transparent",
                      borderRadius: "50%",
                      animation: "mcspin .8s linear infinite",
                      flex: "none",
                    }}
                  />
                  {runningLabel}
                  <span style={{ color: "var(--t5)" }}>
                    · 第 {roundNo} 轮{usage ? ` · 已用 ${fmtK(usage.used)} tokens` : ""}
                  </span>
                  <span
                    className="hv-cardh"
                    onClick={() => connRef.current?.send("user-cancel", {})}
                    style={{
                      marginLeft: "auto",
                      padding: "5px 13px",
                      background: "var(--card2)",
                      borderRadius: 8,
                      color: "var(--err)",
                      cursor: "pointer",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    ■ 停止
                  </span>
                </div>
              </div>
            )}

            {/* queued chip */}
            {queued && (
              <div style={{ display: "flex", justifyContent: "center", padding: "0 24px 8px", flex: "none" }}>
                <div
                  style={{
                    ...COL,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: "var(--t4)",
                    background: "var(--card)",
                    borderRadius: 10,
                    padding: "7px 13px",
                    boxSizing: "border-box",
                  }}
                >
                  <span style={{ animation: "mcpulse 1.2s infinite" }}>⏳</span>已排队:
                  <span style={{ color: "var(--t2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {queued}
                  </span>
                  <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>运行结束后自动发送</span>
                  <span className="hv-err" onClick={() => setQueued(null)} style={{ cursor: "pointer", color: "var(--t5)" }}>
                    ✕
                  </span>
                </div>
              </div>
            )}

            {/* composer */}
            <div style={{ display: "flex", justifyContent: "center", padding: "0 24px 20px", flex: "none" }}>
              <div
                style={{
                  ...COL,
                  background: "var(--card)",
                  border: `1px solid ${yolo ? "var(--err)" : "var(--line)"}`,
                  borderRadius: 16,
                  padding: "13px 16px",
                }}
              >
                <textarea
                  ref={taRef}
                  rows={1}
                  value={input}
                  placeholder={chat.running ? "补充说明…运行中发送会排队" : "输入任务…"}
                  onChange={(e) => setInput(e.target.value)}
                  onCompositionEnd={markImeEnd}
                  onKeyDown={(e) => {
                    // 输入法组合态(选字/确认候选)的 Enter 不发送
                    if (e.key === "Enter" && !e.shiftKey && !isImeEnter(e)) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  style={{
                    width: "100%",
                    background: "none",
                    border: "none",
                    outline: "none",
                    resize: "none",
                    color: "var(--t1)",
                    fontSize: 13.5,
                    lineHeight: 1.6,
                    maxHeight: 160,
                    padding: 0,
                    display: "block",
                    boxSizing: "border-box",
                  }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, fontSize: 12, color: "var(--t5)" }}>
                  <span>⏎ 发送 · ⇧⏎ 换行 · ⇧⇥ YOLO</span>
                  {yolo && (
                    <span style={{ color: "var(--err)", whiteSpace: "nowrap" }}>所有操作不经确认直接执行</span>
                  )}
                  <div
                    className={yolo ? undefined : "hv-card2"}
                    title="切换 YOLO 模式(⇧Tab):开启后所有操作不再询问,直接执行"
                    onClick={() => void toggleYolo()}
                    style={{
                      marginLeft: "auto",
                      padding: "4px 9px",
                      borderRadius: 7,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      fontSize: 11.5,
                      userSelect: "none",
                      flex: "none",
                      color: yolo ? "var(--err)" : "var(--t4)",
                      background: yolo ? "var(--delBg)" : undefined,
                    }}
                  >
                    {yolo ? "⚡ YOLO" : "默认权限"}
                  </div>
                  <div style={{ position: "relative", flex: "none" }}>
                    <div
                      className={chat.running ? undefined : "hv-card2"}
                      title={chat.running ? "轮次执行中,结束后可切换" : "切换本会话模型(下一轮生效)"}
                      onClick={() => !chat.running && setMenuOpen(!menuOpen)}
                      style={{
                        padding: "4px 9px",
                        borderRadius: 7,
                        cursor: chat.running ? "default" : "pointer",
                        whiteSpace: "nowrap",
                        fontSize: 11.5,
                        color: chat.running ? "var(--t5)" : "var(--t4)",
                        userSelect: "none",
                      }}
                    >
                      {currentModel || "模型"} ▾
                    </div>
                    {menuOpen && (
                      <>
                        <div style={{ position: "fixed", inset: 0, zIndex: 29 }} onClick={() => setMenuOpen(false)} />
                        <div
                          style={{
                            position: "absolute",
                            bottom: 32,
                            right: 0,
                            width: 220,
                            background: "var(--pop)",
                            border: "1px solid var(--line)",
                            borderRadius: 12,
                            boxShadow: "var(--shadow)",
                            padding: 6,
                            zIndex: 30,
                            animation: "mcin .15s ease",
                          }}
                        >
                          {menuModels.map((m) => (
                            <div
                              key={m.name}
                              className="hv-card"
                              onClick={() => void switchModel(m.name)}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                padding: "8px 11px",
                                borderRadius: 8,
                                cursor: "pointer",
                                fontSize: 12.5,
                                color: m.name === currentModel ? "var(--amberT)" : "var(--t2)",
                                fontWeight: m.name === currentModel ? 600 : 400,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {m.name}
                              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--t5)", fontWeight: 400 }}>
                                {m.default ? "默认" : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <span style={{ fontSize: 11, color: "var(--t5)" }}>
                    {usage ? `${fmtK(usage.used)} / ${fmtK(usage.size)}` : ""}
                  </span>
                  <div
                    className="hv-op"
                    onClick={send}
                    title="发送"
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 9,
                      background: "var(--amber)",
                      color: "var(--onAmber)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 800,
                      cursor: "pointer",
                      opacity: input.trim() ? 1 : 0.4,
                    }}
                  >
                    ↑
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ============ 改动抽屉 ============ */}
      {drawerOpen && (
        <>
          <div onClick={() => setDrawerOpen(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 35 }} />
          <div
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              width: 600,
              maxWidth: "80vw",
              background: "var(--pop)",
              borderLeft: "1px solid var(--line)",
              boxShadow: "var(--shadow)",
              zIndex: 36,
              display: "flex",
              flexDirection: "column",
              animation: "mcslide .22s ease",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px 12px", flex: "none", whiteSpace: "nowrap" }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--t1)" }}>
                改动{changes && changes.length > 0 ? ` · ${changes.length} 个文件` : ""}
              </span>
              <span
                className="hv-t1"
                onClick={() => setDrawerOpen(false)}
                style={{ marginLeft: "auto", color: "var(--t4)", cursor: "pointer", fontSize: 14 }}
              >
                ✕
              </span>
            </div>
            {changesErr && (
              <div style={{ padding: "10px 20px", fontSize: 12, color: "var(--err)" }}>{changesErr}</div>
            )}
            {changes && changes.length === 0 && !changesErr && (
              <div style={{ padding: "10px 20px", fontSize: 12, color: "var(--t5)" }}>无改动(或非 git 仓库)</div>
            )}
            {changes && changes.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "0 20px 12px", flex: "none" }}>
                {changes.map((c) => {
                  const active = diff?.path === c.path;
                  return (
                    <div
                      key={c.path}
                      className="hv-cardh"
                      onClick={() => void showDiff(c.path)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        background: active ? "var(--card2)" : "transparent",
                        border: "1px solid var(--line)",
                        borderRadius: 9,
                        padding: "6px 11px",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span
                        style={{
                          font: "700 11px " + MONO,
                          color: c.status === "A" ? "var(--ok)" : c.status === "D" ? "var(--err)" : "var(--amberT)",
                        }}
                      >
                        {c.status}
                      </span>
                      <span style={{ font: "11.5px " + MONO, color: active ? "var(--t1)" : "var(--t3)" }}>
                        {basename(c.path)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {diff && (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 20px",
                    borderTop: "1px solid var(--line)",
                    flex: "none",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                  }}
                >
                  <span style={{ font: "12.5px " + MONO, color: "var(--t1)" }}>{basename(diff.path)}</span>
                  <span style={{ fontSize: 11, color: "var(--t5)", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {diff.path}
                  </span>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "4px 0 20px" }}>
                  <DiffPanel text={diff.text} />
                </div>
              </>
            )}
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
            background: "rgba(0,0,0,.45)",
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
              borderRadius: 20,
              boxShadow: "var(--shadow)",
              padding: "22px 24px",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              animation: "mcin .2s ease",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12, whiteSpace: "nowrap" }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis" }}>
                子代理会话 {childView}
              </span>
              <span
                className="hv-t1"
                onClick={() => setChildView(null)}
                style={{ marginLeft: "auto", color: "var(--t4)", cursor: "pointer", fontSize: 14 }}
              >
                ✕
              </span>
            </div>
            <SessionViewer id={childView} />
          </div>
        </div>
      )}
    </div>
  );
}

/** 子会话只读回放/跟看:复用同一 WS 协议(服务端对子会话走观察者路径) */
function SessionViewer({ id }: { id: string }) {
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
    <div
      style={{
        overflowY: "auto",
        flex: 1,
        paddingRight: 6,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        lineHeight: 1.8,
      }}
    >
      <div style={{ color: "var(--t4)", fontSize: 12 }}>{status}</div>
      <LogList items={chat.items} onPermAnswer={() => {}} />
    </div>
  );
}
