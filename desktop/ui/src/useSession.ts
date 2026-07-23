// 会话状态容器 hook:WS 连接生命周期、帧归约、composer(输入/排队/附件)、
// 模型与权限模式切换、改动查询,统一收口为一个句柄。App 只留布局切换与
// App 级浮层,ChatView 整体消费句柄而非逐项 props。协议层(client/reduce)不变。
import { useCallback, useEffect, useRef, useState } from "react";
import { connect, type Conn } from "./session";
import { uploadFile, uploadFileURL } from "./uploads";
import { b64encode } from "./codec";
import { answerAsk as applyAskAnswer, answerPerm as applyPermAnswer, initialChat, reduceBatch, type ChatState } from "./reduce";
import type { Attachment, FileChange, FileEntry, Frame, SessionNotice } from "./types";

export type PermAction = "allow" | "always" | "persist" | "deny";

/** 「上次会话」记忆:读写统一在本模块(open 写入、close(forget) 清除、App 启动恢复时读)。 */
const LAST_SESSION_KEY = "mc.lastSession";
export const lastSessionId = () => localStorage.getItem(LAST_SESSION_KEY);

/** 单附件上传:File → base64 → 壳命令落盘工作区 uploads 目录,返回附件
 * 描述(超限/读取/上传失败抛出)。会话内 addFiles 与新建会话的首条消息
 * 附件共用。 */
async function uploadAtt(sid: string, f: File): Promise<Attachment> {
  if (f.size > 20 * 1024 * 1024) throw new Error(`${f.name || "文件"} 过大(上限 20MB)`);
  const dataURL = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsDataURL(f);
  });
  const b64 = dataURL.slice(dataURL.indexOf(",") + 1);
  const isImage = f.type.startsWith("image/");
  const { path } = await uploadFile(sid, f.name, f.type, b64);
  return { path, isImage, name: f.name || path.split("/").pop() || "", preview: isImage ? dataURL : undefined };
}

export interface SessionHandle {
  /** 当前会话 ID(null = 未打开) */
  id: string | null;
  chat: ChatState;
  /** 连接状态文案(侧栏状态行,只反映连接) */
  status: string;
  /** 会话区短暂提示(自动消退;与连接状态分渠道——
   * 此前混用状态行,一条"切换失败"一闪即被 conn-status 覆盖,
   * 表现为"点了没反应") */
  notice: SessionNotice | null;
  dismissNotice(): void;
  connected: boolean;
  /** 会话当前模型(空 = 未知,调用方回退默认模型展示) */
  model: string;
  yolo: boolean;
  input: string;
  queued: string | null;
  atts: Attachment[];
  changes: FileChange[] | null;
  changesErr: string;
  /** 已上传附件/工作区图片的回读 URL(无会话时 undefined) */
  uploadUrl?: (path: string) => Promise<string>;

  /** 打开会话并接上 WS;firstMessage 在连接就绪后自动发出(新建会话的
   * 首个任务);firstFiles 此刻上传落盘,按 send() 同款「[图片] 路径」
   * 约定拼进首条消息(新建任务页的附件——那时会话还不存在,传不了) */
  open(id: string, opts?: { model?: string; mode?: string; firstMessage?: string; firstFiles?: File[] }): void;
  /** 断开并复位;forget 时一并清掉"上次会话"记忆(删除流程) */
  close(forget?: boolean): void;
  setInput(v: string): void;
  /** 发送输入+附件;运行中自动排队,本轮结束发出。
   * 返回本次输入是否已接受(已发送或已排队),视图据此决定是否跟随最新消息。 */
  send(): boolean;
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
  /** 外显一条提示；默认错误色，targetSessionId 存在时由视图提供跳转。 */
  notify(text: string, options?: Partial<Pick<SessionNotice, "tone" | "targetSessionId">>): void;
}

export function useSession(opts: { onSessionsChanged?: () => void } = {}): SessionHandle {
  const [id, setId] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatState>(initialChat);
  const [status, setStatus] = useState("未连接");
  // 连接态取 onStatus 回调的权威布尔,不从 status 文案推导
  const [connected, setConnected] = useState(false);
  // 短暂提示独立渠道(自动消退),不占用连接状态行
  const [notice, setNotice] = useState<SessionNotice | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const pushNotice = (
    text: string,
    options: Partial<Pick<SessionNotice, "tone" | "targetSessionId">> = {},
  ) => {
    setNotice({ text, tone: options.tone ?? "error", targetSessionId: options.targetSessionId });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 8000);
  };
  const dismissNotice = () => {
    window.clearTimeout(noticeTimer.current);
    setNotice(null);
  };
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  const [input, setInput] = useState("");
  const [queued, setQueued] = useState<string | null>(null);
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const [changesErr, setChangesErr] = useState("");

  const connRef = useRef<Conn | null>(null);
  const pendingMsgRef = useRef<string | null>(null); // 新建会话时输入的首个任务,连上后发出
  // 新建会话时暂存的附件:连上后上传,附件行并入 pendingMsg(只上传一次,
  // 带会话 id 避免闭包对不上)
  const pendingFilesRef = useRef<{ sid: string; files: File[] } | null>(null);
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

  const open = useCallback((sid: string, o: { model?: string; mode?: string; firstMessage?: string; firstFiles?: File[] } = {}) => {
    connRef.current?.close();
    setId(sid);
    // model/permMode 以 ChatState 为唯一真值:meta 值作为初值注入,后续
    // model_update / permission_mode_update 帧经 reduce 覆盖(回放/多客户端
    // 同步)。此前 hook 里另存镜像 state 靠 effect 缝合,存在不一致窗口。
    setChat({ ...initialChat, model: o.model ?? "", permMode: o.mode ?? "" });
    setQueued(null);
    setAtts([]);
    setChanges(null);
    setChangesErr("");
    pendingMsgRef.current = o.firstMessage ?? null;
    pendingFilesRef.current = o.firstFiles?.length ? { sid, files: o.firstFiles } : null;
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
    pendingFilesRef.current = null;
    setId(null);
    setChat(initialChat);
    setStatus("未连接");
    setConnected(false);
    setQueued(null);
    setAtts([]);
    setChanges(null);
    setChangesErr("");
    if (forget) localStorage.removeItem(LAST_SESSION_KEY);
  }, []);

  // 连接就绪:拉改动计数;若新建会话时带了首个任务/附件,此刻发出。
  // 附件先上传拿到工作区路径,附件行按 send() 同款约定并入正文;上传结果
  // (含失败后的残句)回写 pendingMsgRef,send 失败时下次 connected 重试
  // 只重发文本,不重复上传。
  useEffect(() => {
    if (!connected) return;
    void refreshChanges();
    if (!pendingMsgRef.current && !pendingFilesRef.current) return;
    void (async () => {
      let text = pendingMsgRef.current ?? "";
      const pf = pendingFilesRef.current;
      if (pf) {
        pendingFilesRef.current = null;
        const lines: string[] = [];
        for (const f of pf.files) {
          try {
            const a = await uploadAtt(pf.sid, f);
            lines.push(`${a.isImage ? "[图片]" : "[文件]"} ${a.path}`);
          } catch (e) {
            pushNotice("⚠ 附件上传失败: " + (e instanceof Error ? e.message : String(e)));
          }
        }
        text = [text, ...lines].filter(Boolean).join("\n");
        pendingMsgRef.current = text || null;
      }
      if (!text) return;
      const ok = await connRef.current?.send("user-input", { content: b64encode(text) });
      if (ok) pendingMsgRef.current = null;
    })();
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

  const send = (): boolean => {
    const lines = atts.map((a) => `${a.isImage ? "[图片]" : "[文件]"} ${a.path}`);
    const text = [input.trim(), ...lines].filter(Boolean).join("\n");
    if (!text || !connRef.current) return false;
    if (chat.running) {
      // 运行中先排队,本轮结束自动发送(可取消)
      setQueued(text);
      setInput("");
      setAtts([]);
      return true;
    }
    void connRef.current.send("user-input", { content: b64encode(text) }).then((ok) => {
      // 失败时保留输入与附件(原因已经 onStatus 外显),用户可重试
      if (ok) {
        setInput("");
        setAtts([]);
      }
    });
    return true;
  };

  const addFiles = async (files: File[]) => {
    if (!id) return;
    for (const f of files) {
      try {
        const a = await uploadAtt(id, f);
        setAtts((x) => [...x, a]);
      } catch (e) {
        pushNotice("⚠ 附件上传失败: " + (e instanceof Error ? e.message : String(e)));
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
    if (!connRef.current || !name || name === chat.model) return;
    try {
      const r = await connRef.current.call<{ result?: { model: string }; error?: string }>(
        "session_set_model",
        { model: name },
      );
      if (r.error) {
        pushNotice("⚠ 切换模型失败: " + r.error);
        return;
      }
      // 成功即回写 chat(唯一真值),不等 model_update 帧——帧到达时幂等
      // 覆盖并渲染系统行;不做失败前的乐观更新是因为切换可即时校验
      setChat((s) => ({ ...s, model: name }));
      onSessionsChangedRef.current?.();
    } catch (e) {
      pushNotice("⚠ 切换模型失败: " + (e instanceof Error ? e.message : e));
    }
  };

  const toggleYolo = async () => {
    if (!connRef.current) return;
    const prevMode = chat.permMode;
    const next = prevMode === "yolo" ? "default" : "yolo";
    // 乐观回写 chat(唯一真值),失败按原值回滚;permission_mode_update
    // 帧到达后幂等覆盖并渲染系统行
    setChat((s) => ({ ...s, permMode: next }));
    try {
      const r = await connRef.current.call<{ result?: { mode: string }; error?: string }>(
        "session_set_mode",
        { mode: next },
      );
      if (r.error) {
        setChat((s) => ({ ...s, permMode: prevMode }));
        pushNotice("⚠ 切换权限模式失败: " + r.error);
      }
    } catch (e) {
      setChat((s) => ({ ...s, permMode: prevMode }));
      pushNotice("⚠ 切换权限模式失败: " + (e instanceof Error ? e.message : e));
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
    notice,
    dismissNotice,
    connected,
    // 由 chat 派生对外(SessionHandle 形状不变):ChatState 是唯一真值
    model: chat.model,
    yolo: chat.permMode === "yolo",
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
    notify: pushNotice,
  };
}
