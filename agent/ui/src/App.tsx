import { useCallback, useEffect, useRef, useState } from "react";
import {
  b64encode,
  connect,
  createSession,
  inDesktopShell,
  listModels,
  listSessions,
  openHostSettings,
  pickDirectory,
  type Conn,
} from "./client";
import { DiffView, LogItemView, SessionItem } from "./components";
import { answerPerm, initialChat, reduceBatch, type ChatState } from "./reduce";
import type { FileChange, Frame, ModelInfo, SessionMeta } from "./types";

type Tab = "chat" | "changes";

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

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatState>(initialChat);
  const [status, setStatus] = useState("未连接");
  const [tab, setTab] = useState<Tab>("chat");
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const [changesErr, setChangesErr] = useState("");
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  const [showNew, setShowNew] = useState<{ dir: string } | null>(null);
  const [input, setInput] = useState("");
  const [childView, setChildView] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sessionModel, setSessionModel] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("mc.collapsedGroups") || "[]") as string[]);
    } catch {
      return new Set();
    }
  });

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
  const pinnedRef = useRef(true); // 用户是否停留在底部(自动跟随滚动)

  const refreshSessions = useCallback(async () => {
    const metas = await listSessions();
    setSessions(metas);
    return metas;
  }, []);

  const refreshChanges = useCallback(async () => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      const r = await conn.call<{ result?: FileChange[]; error?: string }>("repo_file_changes");
      if (r.error) {
        setChangesErr(r.error);
        setChanges([]);
      } else {
        setChangesErr("");
        setChanges(r.result ?? []);
      }
    } catch (e) {
      setChangesErr(e instanceof Error ? e.message : String(e));
      setChanges([]);
    }
  }, []);

  const openSession = useCallback(
    (id: string, model?: string) => {
      connRef.current?.close();
      setCurrentId(id);
      setChat(initialChat);
      setChanges(null);
      setChangesErr("");
      setTab("chat");
      setSessionModel(model ?? "");
      localStorage.setItem("mc.lastSession", id);
      connRef.current = connect(id, {
        onFrames: (batch: Frame[]) => setChat((s) => reduceBatch(s, batch)),
        onStatus: (text) => setStatus(text),
      });
      void refreshSessions();
    },
    [refreshSessions],
  );

  // 启动:拉模型清单 + 恢复上次会话
  useEffect(() => {
    listModels()
      .then(setModels)
      .catch(() => {});
    refreshSessions()
      .then((metas) => {
        const last = localStorage.getItem("mc.lastSession");
        const meta = metas.find((m) => m.id === last);
        if (meta) openSession(meta.id, meta.model);
      })
      .catch((e) => setStatus("无法连接服务: " + (e instanceof Error ? e.message : e)));
    return () => connRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // model_update 帧回写当前模型显示
  useEffect(() => {
    if (chat.model) setSessionModel(chat.model);
  }, [chat.model]);

  // 本轮结束:刷新改动计数与会话列表
  useEffect(() => {
    if (!chat.turnEnded) return;
    setChat((s) => ({ ...s, turnEnded: false }));
    void refreshChanges();
    void refreshSessions();
  }, [chat.turnEnded, refreshChanges, refreshSessions]);

  // 自动滚动(仅当用户停留在底部)
  useEffect(() => {
    const el = logRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [chat.items]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const send = () => {
    const text = input.trim();
    if (!text || chat.running || !connRef.current) return;
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

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="brand-name">MonkeyCode</span>
          <span className="hint">本地内核</span>
        </div>
        <button className="primary wide" onClick={() => setShowNew({ dir: "" })}>
          + 新建会话
        </button>
        <div className="sessions">
          {groupByProject(sessions).map((g) => (
            <div key={g.dir} className="group">
              <div className="group-head" title={g.dir} onClick={() => toggleGroup(g.dir)}>
                <span className="chev">{collapsed.has(g.dir) ? "▸" : "▾"}</span>
                <span className="group-name">{g.name}</span>
                <span className="hint">{g.items.length}</span>
                <button
                  className="group-plus"
                  title={"在 " + g.dir + " 新建会话"}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowNew({ dir: g.dir });
                  }}
                >
                  +
                </button>
              </div>
              {!collapsed.has(g.dir) &&
                g.items.map((m) => (
                  <SessionItem
                    key={m.id}
                    meta={m}
                    active={m.id === currentId}
                    onClick={() => openSession(m.id, m.model)}
                  />
                ))}
            </div>
          ))}
          {sessions.length === 0 && <div className="hint pad">暂无会话</div>}
        </div>
        <button
          className="ghost wide settings-btn"
          onClick={() => openHostSettings((msg) => setStatus("⚠ " + msg))}
        >
          ⚙ 设置
        </button>
      </aside>

      <main className="main">
        <nav className="tabs">
          <button className={"tab" + (tab === "chat" ? " active" : "")} onClick={() => setTab("chat")}>
            对话
          </button>
          <button
            className={"tab" + (tab === "changes" ? " active" : "")}
            onClick={() => {
              setTab("changes");
              void refreshChanges();
            }}
          >
            改动{changes && changes.length > 0 ? ` (${changes.length})` : ""}
          </button>
        </nav>

        {tab === "chat" ? (
          <div className="log" ref={logRef} onScroll={onLogScroll}>
            {currentId === null && <div className="sysline">选择或创建一个会话开始</div>}
            {chat.items.map((item, i) => (
              <LogItemView key={i} item={item} onPermAnswer={onPermAnswer} onOpenChild={setChildView} />
            ))}
          </div>
        ) : (
          <div className="changes">
            {changes === null && <div className="sysline">加载中…</div>}
            {changesErr && <div className="sysline err">{changesErr}</div>}
            {changes && !changesErr && changes.length === 0 && (
              <div className="sysline">无改动(或非 git 仓库)</div>
            )}
            {changes?.map((c) => (
              <div key={c.path} className="chg" onClick={() => void showDiff(c.path)}>
                <span className={"chg-st " + c.status}>{c.status}</span>
                <span>{c.path}</span>
              </div>
            ))}
          </div>
        )}

        <div className="composer">
          <textarea
            value={input}
            placeholder="输入任务…(Enter 发送,Shift+Enter 换行)"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 输入法组合态(选字/确认候选)的 Enter 不发送
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="primary" disabled={chat.running || !currentId} onClick={send}>
            发送
          </button>
          <button
            className="danger"
            disabled={!chat.running}
            onClick={() => connRef.current?.send("user-cancel", {})}
          >
            停止
          </button>
        </div>
        <footer className="status">
          <span>{status}</span>
          <span className="status-right">
            {currentId && models.length > 0 && (
              <select
                className="model-select"
                value={sessionModel || models.find((m) => m.default)?.name || ""}
                disabled={chat.running}
                title={chat.running ? "轮次执行中,结束后可切换" : "切换本会话模型(下一轮生效)"}
                onChange={(e) => void switchModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
                {sessionModel && !models.some((m) => m.name === sessionModel) && (
                  <option value={sessionModel}>{sessionModel}</option>
                )}
              </select>
            )}
            {chat.usage ? `上下文 ${chat.usage.used} / ${chat.usage.size} tokens` : ""}
          </span>
        </footer>
      </main>

      {diff && (
        <div className="modal-backdrop" onClick={() => setDiff(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b>{diff.path}</b>
              <button className="ghost" onClick={() => setDiff(null)}>
                关闭
              </button>
            </div>
            <DiffView text={diff.text} />
          </div>
        </div>
      )}

      {childView && (
        <div className="modal-backdrop" onClick={() => setChildView(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b>子代理会话 {childView}</b>
              <button className="ghost" onClick={() => setChildView(null)}>
                关闭
              </button>
            </div>
            <SessionViewer id={childView} />
          </div>
        </div>
      )}

      {showNew && (
        <NewSessionDialog
          models={models}
          initialDir={showNew.dir}
          onClose={() => setShowNew(null)}
          onCreated={(meta) => {
            setShowNew(null);
            void refreshSessions().then(() => openSession(meta.id, meta.model));
          }}
        />
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
    <div className="child-log">
      <div className="hint">{status}</div>
      {chat.items.map((item, i) => (
        <LogItemView key={i} item={item} onPermAnswer={() => {}} />
      ))}
    </div>
  );
}

function NewSessionDialog({
  models,
  initialDir,
  onClose,
  onCreated,
}: {
  models: ModelInfo[];
  initialDir: string;
  onClose: () => void;
  onCreated: (meta: SessionMeta) => void;
}) {
  const [workdir, setWorkdir] = useState(initialDir);
  const [model, setModel] = useState(models.find((m) => m.default)?.name ?? "");
  const [err, setErr] = useState("");
  const [offerCreate, setOfferCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  const create = async (createDir = false) => {
    if (!workdir.trim() || busy) return;
    setBusy(true);
    setErr("");
    setOfferCreate(false);
    try {
      onCreated(await createSession(workdir.trim(), model, createDir));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr("创建失败: " + msg);
      if (msg.includes("目录不存在")) setOfferCreate(true);
      setBusy(false);
    }
  };

  const browse = async () => {
    const dir = await pickDirectory();
    if (dir) {
      setWorkdir(dir);
      setErr("");
      setOfferCreate(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <h3>新建会话</h3>
        <p className="hint">工作区目录</p>
        <div className="dir-row">
          <input
            type="text"
            autoFocus
            value={workdir}
            placeholder="/home/you/dev/project"
            onChange={(e) => setWorkdir(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void create()}
          />
          {inDesktopShell() && (
            <button className="ghost" onClick={() => void browse()}>
              浏览…
            </button>
          )}
        </div>
        {models.length > 1 && (
          <>
            <p className="hint" style={{ marginTop: 12 }}>
              模型
            </p>
            <select className="model-select wide" value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.default ? "(默认)" : ""}
                </option>
              ))}
            </select>
          </>
        )}
        {err && <div className="sysline err">{err}</div>}
        {offerCreate && (
          <div className="sysline">
            <button className="ghost" disabled={busy} onClick={() => void create(true)}>
              创建该目录并继续
            </button>
          </div>
        )}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy} onClick={() => void create()}>
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
