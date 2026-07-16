// 状态容器 + 布局切换:侧栏常驻,主区在 Chat / New Task / Settings 三屏间切换。
// 视觉对照「MonkeyCode 桌面应用设计」;协议层(client/reduce)不变。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  b64encode,
  connect,
  createSession,
  deleteSession,
  inDesktopShell,
  getHostInfo,
  listModels,
  listSessions,
  onHostEvent,
  setSessionArchived,
  updateCheck,
  type Conn,
  type UpdateStatus,
} from "./client";
import { basename, ChatView } from "./chat";
import { DiffPanel, LogList, MONO } from "./components";
import { IconX } from "./icons";
import { NewTaskView } from "./newtask";
import { answerPerm, initialChat, reduceBatch, type ChatState } from "./reduce";
import { groupByProject, Sidebar } from "./sidebar";
import { SettingsView } from "./settings";
import type { FileChange, Frame, LogItem, ModelInfo, SessionMeta } from "./types";

/** 首启默认工作目录(内核解析 ~,不存在时自动创建);老用户默认沿用最近会话的目录 */
const DEFAULT_DIR = "~/MonkeyCode";

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
  const [childView, setChildView] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sessionModel, setSessionModel] = useState("");
  const [yolo, setYolo] = useState(false);
  const [hostVersion, setHostVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  // 新建任务视图
  const [newDir, setNewDir] = useState(DEFAULT_DIR);
  const [newModel, setNewModel] = useState("");
  const [newText, setNewText] = useState("");
  const [newErr, setNewErr] = useState("");
  const [offerCreate, setOfferCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  const connRef = useRef<Conn | null>(null);
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
  // 另订阅壳的托盘"设置"事件,静默检查一次应用更新(齿轮上的小圆点)。
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
    if (inDesktopShell()) {
      void getHostInfo().then((info) => setHostVersion(info?.version ?? null));
      updateCheck()
        .then(setUpdate)
        .catch(() => {}); // 静默:自动检查失败不打扰
    }
    return () => {
      offSettings();
      connRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // model_update / permission_mode_update 帧回写(回放/多客户端同步)
  useEffect(() => {
    if (chat.model) setSessionModel(chat.model);
  }, [chat.model]);
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

  // 排队的输入:运行结束后自动发送
  useEffect(() => {
    if (chat.running || !queued) return;
    if (connRef.current?.send("user-input", { content: b64encode(queued) })) setQueued(null);
  }, [chat.running, queued]);

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

  // ===== 派生状态 =====
  const currentMeta = sessions.find((m) => m.id === currentId);
  const currentModel = sessionModel || models.find((m) => m.default)?.name || "";
  const menuModels: ModelInfo[] =
    sessionModel && !models.some((m) => m.name === sessionModel)
      ? [...models, { name: sessionModel, default: false }]
      : models;
  const openPerm = [...chat.items].reverse().find((it) => it.kind === "perm" && it.state === "open") as
    | Extract<LogItem, { kind: "perm" }>
    | undefined;
  const isNewView = view === "new" || currentId === null;
  const recentDirs = (() => {
    const dirs = groupByProject(sessions.filter((m) => !m.archived)).map((g) => g.dir);
    if (!dirs.includes(newDir)) dirs.unshift(newDir);
    return dirs.slice(0, 6);
  })();

  // ===== 全局快捷键:⇧⇥ 权限模式、⏎/esc 应答审批、esc 关闭浮层 =====
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.shiftKey && view === "session" && currentId) {
        e.preventDefault();
        void toggleYolo();
        return;
      }
      if (e.key === "Escape") {
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
        color: "var(--t1)",
        fontSize: 13,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <Sidebar
        sessions={sessions}
        currentId={currentId}
        sessionActive={view === "session"}
        connected={connected}
        status={status}
        settingsActive={view === "settings"}
        updateAvailable={!!update?.available}
        onSelect={(m) => openSession(m.id, m.model, m.mode)}
        onNewTask={(dir) => {
          if (dir) {
            dirTouchedRef.current = true;
            setNewDir(dir);
          }
          setNewErr("");
          setOfferCreate(false);
          setView("new");
        }}
        onOpenSettings={() => setView("settings")}
        onArchive={(m) => void archiveSession(m)}
        onDelete={(m) => void removeSession(m)}
      />

      {/* ============ 主区 ============ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        {view === "settings" ? (
          <SettingsView
            onClose={() => setView(currentId ? "session" : "new")}
            hostVersion={hostVersion}
            update={update}
            onUpdateStatus={setUpdate}
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
            chat={chat}
            changesCount={changes?.length ?? 0}
            input={input}
            setInput={setInput}
            queued={queued}
            models={menuModels}
            currentModel={currentModel}
            yolo={yolo}
            onSend={send}
            onStop={() => connRef.current?.send("user-cancel", {})}
            onClearQueued={() => setQueued(null)}
            onToggleYolo={() => void toggleYolo()}
            onSwitchModel={(name) => void switchModel(name)}
            onOpenDrawer={openDrawer}
            onPermAnswer={onPermAnswer}
            onOpenChild={setChildView}
            onArchive={() => currentMeta && void archiveSession(currentMeta)}
            onDelete={() => currentMeta && void removeSession(currentMeta)}
          />
        )}
      </div>

      {/* ============ 改动抽屉 ============ */}
      {drawerOpen && (
        <>
          <div onClick={() => setDrawerOpen(false)} style={{ position: "absolute", inset: 0, background: "rgba(20,30,25,.25)", zIndex: 35 }} />
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
              <span style={{ fontSize: 13.5, fontWeight: 700 }}>
                改动{changes && changes.length > 0 ? ` · ${changes.length} 个文件` : ""}
              </span>
              <button className="hv2" onClick={() => setDrawerOpen(false)} style={{ marginLeft: "auto", width: 24, height: 24, border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6 }}>
                <IconX size={11} color="var(--t4)" />
              </button>
            </div>
            {changesErr && <div style={{ padding: "10px 20px", fontSize: 12, color: "var(--err)" }}>{changesErr}</div>}
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
                      className="hv"
                      onClick={() => void showDiff(c.path)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        background: active ? "var(--hov)" : "transparent",
                        border: "1px solid var(--line)",
                        borderRadius: 8,
                        padding: "6px 11px",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span
                        style={{
                          font: "700 11px " + MONO,
                          color: c.status === "A" ? "var(--ok)" : c.status === "D" ? "var(--err)" : "var(--warn)",
                        }}
                      >
                        {c.status}
                      </span>
                      <span style={{ font: "11.5px " + MONO, color: active ? "var(--t1)" : "var(--t3)" }}>{basename(c.path)}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {diff && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 20px", borderTop: "1px solid var(--line2)", flex: "none", whiteSpace: "nowrap", overflow: "hidden" }}>
                  <span style={{ font: "12.5px " + MONO, color: "var(--t1)" }}>{basename(diff.path)}</span>
                  <span style={{ fontSize: 11, color: "var(--t5)", overflow: "hidden", textOverflow: "ellipsis" }}>{diff.path}</span>
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
            background: "rgba(20,30,25,.35)",
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
              boxShadow: "0 24px 70px rgba(30,45,38,.3)",
              padding: "20px 24px",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              animation: "mcin .2s ease",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12, whiteSpace: "nowrap" }}>
              <span style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>
                子代理会话 {childView}
              </span>
              <button className="hv2" onClick={() => setChildView(null)} style={{ marginLeft: "auto", width: 24, height: 24, border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6 }}>
                <IconX size={11} color="var(--t4)" />
              </button>
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
    <div style={{ overflowY: "auto", flex: 1, paddingRight: 6, display: "flex", flexDirection: "column", gap: 14, lineHeight: 1.8 }}>
      <div style={{ color: "var(--t4)", fontSize: 12 }}>{status}</div>
      <LogList items={chat.items} onPermAnswer={() => {}} />
    </div>
  );
}
