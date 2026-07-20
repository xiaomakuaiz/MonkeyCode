// 会话状态容器 hook:WS 连接生命周期、帧归约、composer(输入/排队/附件)、
// 模型与权限模式切换、改动查询,统一收口为一个句柄。App 只留布局切换与
// App 级浮层,ChatView 整体消费句柄而非逐项 props。协议层(client/reduce)不变。
import { useCallback, useEffect, useRef, useState } from "react";
import { connect, uploadFile, uploadFileURL, type Conn } from "./client";
import { b64encode } from "./codec";
import { answerAsk as applyAskAnswer, answerPerm as applyPermAnswer, initialChat, reduceBatch, type ChatState } from "./reduce";
import type { Attachment, FileChange, FileEntry, Frame } from "./types";

export type PermAction = "allow" | "always" | "persist" | "deny";

/** 「上次会话」记忆:读写统一在本模块(open 写入、close(forget) 清除、App 启动恢复时读)。 */
const LAST_SESSION_KEY = "mc.lastSession";
export const lastSessionId = () => localStorage.getItem(LAST_SESSION_KEY);

export interface SessionHandle {
  /** 当前会话 ID(null = 未打开) */
  id: string | null;
  chat: ChatState;
  /** 连接状态/告警文案(侧栏状态行) */
  status: string;
  connected: boolean;
  /** 会话当前模型(空 = 未知,调用方回退默认模型展示) */
  model: string;
  yolo: boolean;
  input: string;
  queued: string | null;
  atts: Attachment[];
  changes: FileChange[] | null;
  changesErr: string;
  /** 已上传文件的回读 URL(无会话时 undefined) */
  uploadUrl?: (path: string) => Promise<string>;

  /** 打开会话并接上 WS;firstMessage 在连接就绪后自动发出(新建会话的首个任务) */
  open(id: string, opts?: { model?: string; mode?: string; firstMessage?: string }): void;
  /** 断开并复位;forget 时一并清掉"上次会话"记忆(删除流程) */
  close(forget?: boolean): void;
  setInput(v: string): void;
  /** 发送输入+附件;运行中自动排队,本轮结束发出 */
  send(): void;
  stop(): void;
  clearQueued(): void;
  addFiles(files: File[]): Promise<void>;
  removeAtt(i: number): void;
  answerPerm(id: string, action: PermAction): void;
  /** 答复 AI 提问卡(reply-question 上行;发送成功后乐观回写 UI) */
  answerAsk(askId: string, answers: Record<string, string | string[]>): void;
  switchModel(name: string): Promise<void>;
  toggleYolo(): Promise<void>;
  refreshChanges(): Promise<FileChange[]>;
  /** repo_file_diff 同步查询(文件抽屉:改动文件的 diff) */
  fileDiff(path: string): Promise<{ result?: { diff?: string }; error?: string }>;
  /** repo_file_list 同步查询(文件抽屉:列目录,单层) */
  listFiles(dir: string): Promise<{ result?: FileEntry[]; error?: string }>;
  /** repo_read_file 同步查询(文件抽屉:读文件内容,内核限 1MB) */
  readFile(path: string): Promise<{ result?: { content?: string }; error?: string }>;
  /** repo_reveal:在系统文件管理器中定位(内核本机执行,浏览器模式同样可用) */
  reveal(path: string): Promise<{ result?: { ok?: boolean }; error?: string }>;
  /** 在状态行外显一条告警(App 级操作失败与连接状态同渠道展示) */
  notify(text: string): void;
}

export function useSession(opts: { onSessionsChanged?: () => void } = {}): SessionHandle {
  const [id, setId] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatState>(initialChat);
  const [status, setStatus] = useState("未连接");
  // 连接态取 onStatus 回调的权威布尔,不从 status 文案推导:
  // status 还兼作告警渠道(notify),文案匹配会把告警误判成断线
  const [connected, setConnected] = useState(false);
  const [model, setModel] = useState("");
  const [yolo, setYolo] = useState(false);
  const [input, setInput] = useState("");
  const [queued, setQueued] = useState<string | null>(null);
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const [changesErr, setChangesErr] = useState("");

  const connRef = useRef<Conn | null>(null);
  const pendingMsgRef = useRef<string | null>(null); // 新建会话时输入的首个任务,连上后发出
  // 回调经 ref 转发,避免调用方每次渲染的新函数搅动下方 effect 依赖
  const onSessionsChangedRef = useRef(opts.onSessionsChanged);
  onSessionsChangedRef.current = opts.onSessionsChanged;

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

  const open = useCallback((sid: string, o: { model?: string; mode?: string; firstMessage?: string } = {}) => {
    connRef.current?.close();
    setId(sid);
    setChat(initialChat);
    setQueued(null);
    setAtts([]);
    setChanges(null);
    setChangesErr("");
    setModel(o.model ?? "");
    setYolo(o.mode === "yolo");
    pendingMsgRef.current = o.firstMessage ?? null;
    localStorage.setItem(LAST_SESSION_KEY, sid);
    connRef.current = connect(sid, {
      onFrames: (batch: Frame[]) => setChat((s) => reduceBatch(s, batch)),
      onStatus: (text, conn) => {
        setStatus(text);
        setConnected(conn);
      },
    });
    onSessionsChangedRef.current?.();
  }, []);

  const close = useCallback((forget = false) => {
    connRef.current?.close();
    connRef.current = null;
    pendingMsgRef.current = null;
    setId(null);
    setChat(initialChat);
    setStatus("未连接");
    setConnected(false);
    setModel("");
    setYolo(false);
    setQueued(null);
    setAtts([]);
    setChanges(null);
    setChangesErr("");
    if (forget) localStorage.removeItem(LAST_SESSION_KEY);
  }, []);

  // model_update / permission_mode_update 帧回写(回放/多客户端同步)
  useEffect(() => {
    if (chat.model) setModel(chat.model);
  }, [chat.model]);
  useEffect(() => {
    if (chat.permMode) setYolo(chat.permMode === "yolo");
  }, [chat.permMode]);

  // 连接就绪:拉改动计数;若新建会话时带了首个任务,此刻发出
  // (send 失败时保留 pending,下次 connected 变化重试)
  useEffect(() => {
    if (!connected) return;
    void refreshChanges();
    const pending = pendingMsgRef.current;
    if (pending) {
      void connRef.current?.send("user-input", { content: b64encode(pending) }).then((ok) => {
        if (ok) pendingMsgRef.current = null;
      });
    }
  }, [connected, refreshChanges]);

  // 本轮结束:刷新改动计数与会话列表
  useEffect(() => {
    if (!chat.turnEnded) return;
    setChat((s) => ({ ...s, turnEnded: false }));
    void refreshChanges();
    onSessionsChangedRef.current?.();
  }, [chat.turnEnded, refreshChanges]);

  // 排队的输入:运行结束后自动发送(失败保留,可再触发或手动重试)
  useEffect(() => {
    if (chat.running || !queued) return;
    void connRef.current?.send("user-input", { content: b64encode(queued) }).then((ok) => {
      if (ok) setQueued(null);
    });
  }, [chat.running, queued]);

  // 卸载即断开
  useEffect(() => () => connRef.current?.close(), []);

  const send = () => {
    const lines = atts.map((a) => `${a.isImage ? "[图片]" : "[文件]"} ${a.path}`);
    const text = [input.trim(), ...lines].filter(Boolean).join("\n");
    if (!text || !connRef.current) return;
    if (chat.running) {
      // 运行中先排队,本轮结束自动发送(可取消)
      setQueued(text);
      setInput("");
      setAtts([]);
      return;
    }
    void connRef.current.send("user-input", { content: b64encode(text) }).then((ok) => {
      // 失败时保留输入与附件(原因已经 onStatus 外显),用户可重试
      if (ok) {
        setInput("");
        setAtts([]);
      }
    });
  };

  const addFiles = async (files: File[]) => {
    if (!id) return;
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) {
        setStatus(`⚠ ${f.name || "文件"} 过大(上限 20MB)`);
        continue;
      }
      try {
        const dataURL = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.onerror = () => reject(new Error("读取文件失败"));
          r.readAsDataURL(f);
        });
        const b64 = dataURL.slice(dataURL.indexOf(",") + 1);
        const isImage = f.type.startsWith("image/");
        const { path } = await uploadFile(id, f.name, f.type, b64);
        setAtts((a) => [
          ...a,
          { path, isImage, name: f.name || path.split("/").pop() || "", preview: isImage ? dataURL : undefined },
        ]);
      } catch (e) {
        setStatus("⚠ 附件上传失败: " + (e instanceof Error ? e.message : String(e)));
      }
    }
  };

  const answerPerm = (pid: string, action: PermAction) => {
    const approved = action !== "deny";
    void connRef.current
      ?.send("permission-resp", {
        id: pid,
        approved,
        remember: action === "always" || action === "persist",
        persist: action === "persist",
      })
      .then((ok) => {
        if (ok) setChat((s) => applyPermAnswer(s, pid, approved));
      });
  };

  // AI 提问卡答复:request_id 即 askId;发送成功即乐观回写(与云端一致)
  const answerAskCb = (askId: string, answers: Record<string, string | string[]>) => {
    void connRef.current
      ?.send("reply-question", {
        request_id: askId,
        answers_json: JSON.stringify(answers),
        cancelled: false,
      })
      .then((ok) => {
        if (ok) setChat((s) => applyAskAnswer(s, askId, answers));
      });
  };

  const switchModel = async (name: string) => {
    if (!connRef.current || !name || name === model) return;
    try {
      const r = await connRef.current.call<{ result?: { model: string }; error?: string }>(
        "session_set_model",
        { model: name },
      );
      if (r.error) {
        setStatus("⚠ 切换模型失败: " + r.error);
        return;
      }
      setModel(name); // model_update 帧也会到达并渲染系统行
      onSessionsChangedRef.current?.();
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

  const fileDiff = (path: string) => {
    const conn = connRef.current;
    if (!conn) return Promise.reject(new Error("未连接"));
    return conn.call<{ result?: { diff?: string }; error?: string }>("repo_file_diff", { path });
  };

  const listFiles = (dir: string) => {
    const conn = connRef.current;
    if (!conn) return Promise.reject(new Error("未连接"));
    return conn.call<{ result?: FileEntry[]; error?: string }>("repo_file_list", { path: dir });
  };

  const readFile = (path: string) => {
    const conn = connRef.current;
    if (!conn) return Promise.reject(new Error("未连接"));
    return conn.call<{ result?: { content?: string }; error?: string }>("repo_read_file", { path });
  };

  const reveal = (path: string) => {
    const conn = connRef.current;
    if (!conn) return Promise.reject(new Error("未连接"));
    return conn.call<{ result?: { ok?: boolean }; error?: string }>("repo_reveal", { path });
  };

  return {
    id,
    chat,
    status,
    connected,
    model,
    yolo,
    input,
    queued,
    atts,
    changes,
    changesErr,
    uploadUrl: id ? (p: string) => uploadFileURL(id, p) : undefined,
    open,
    close,
    setInput,
    send,
    stop: () => void connRef.current?.send("user-cancel", {}),
    clearQueued: () => setQueued(null),
    addFiles,
    removeAtt: (i: number) => setAtts((a) => a.filter((_, j) => j !== i)),
    answerPerm,
    answerAsk: answerAskCb,
    switchModel,
    toggleYolo,
    refreshChanges,
    fileDiff,
    listFiles,
    readFile,
    reveal,
    notify: setStatus,
  };
}
