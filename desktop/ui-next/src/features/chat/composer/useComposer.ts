// composer 状态机:草稿/单槽排队/附件上传/发送与停止。
// 发送面契约(对表壳侧 driver/session.rs::session_send):
// - user-input 载荷只有 {content: b64};本地附件不进独立字段,按
//   「[图片]/[文件] <工作区相对路径>」附件行并入正文(旧 UI ATT_LINE 同
//   口径,壳只解 content)。
// - Err ⟺ 消息未入会话(未物化任何帧)——失败回队/回草稿是安全的;
//   引擎接活后本轮失败会回 Ok(错误走 task-error 帧),不得重投。
// - 停止 = user-cancel {}(取消斡旋与看门狗都在壳侧)。
// 排队语义:运行中/上一条未回执时发送进单槽(后发覆盖先发,chip 外显可
// 取消),轮结束(running 变 false)自动补投;失败回队并压住自动重投,
// 直到下一次 running 变化或用户再次发送。
import { useCallback, useEffect, useRef, useState } from "react";

import { t } from "@/lib/i18n";
import { sessionSend } from "@/lib/ipc/sessions";
import { attLineOf } from "@/lib/protocol/attLine";
import {
  isImagePath,
  nativePathOf,
  uploadFilePath,
  uploadFileStream,
} from "@/lib/ipc/uploads";
import { b64encode } from "@/lib/protocol/codec";

export interface ComposerAtt {
  /** 工作区相对路径(壳返回;附件行与模型可读路径都用它)。 */
  path: string;
  name: string;
  isImage: boolean;
}

export interface ComposerUpload {
  id: number;
  name: string;
  /** 0-100;-1 = 不确定进度(路径直拷/空文件,无分块回调)。 */
  pct: number;
  /** 分块通道可取消;路径直拷不可(无句柄)。 */
  cancel?: () => void;
}

/** 本地附件行(约定唯一出处在 lib/protocol/attLine,进消息正文)。 */
export const attLine = (a: ComposerAtt) => attLineOf(a.path, a.isImage);

export interface ComposerCtl {
  draft: string;
  setDraft(v: string): void;
  queued: string | null;
  clearQueued(): void;
  atts: ComposerAtt[];
  removeAtt(index: number): void;
  uploads: ComposerUpload[];
  /** 短暂错误提示(上传/切换失败;自动消退)。 */
  error: string | null;
  dismissError(): void;
  notifyError(message: string): void;
  /** 发送草稿+附件;运行中自动排队。返回是否已接受(发送或排队)。 */
  send(): boolean;
  stop(): void;
  /** 粘贴/拖拽的 File 上传为附件(path-backed 占位走路径直拷)。 */
  addFiles(files: File[]): Promise<void>;
  /** 系统对话框选出的本地路径直拷为附件。 */
  addPaths(paths: string[]): Promise<void>;
}

const ERROR_TTL_MS = 8000;

export function useComposer(sessionId: string, running: boolean): ComposerCtl {
  const [draft, setDraft] = useState("");
  const [queued, setQueued] = useState<string | null>(null);
  const [atts, setAtts] = useState<ComposerAtt[]>([]);
  const [uploads, setUploads] = useState<ComposerUpload[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 上行在途:user-input 发出到回执/开轮之间再发必须入队,否则第二条直发
  // 会被壳的忙碌守卫拒掉
  const sendingRef = useRef(false);
  // 排队补投失败后的抑制闸:防「失败→回队→effect 立即重投」空转,
  // running 变化或用户再次发送时解除
  const flushBlockedRef = useRef(false);
  const uploadSeqRef = useRef(0);
  const errorTimer = useRef(0);

  // 切会话即整体复位(排队/附件不跨会话;在途上传的收尾回调按 id 过滤,
  // 清空后的 filter/map 无害)
  useEffect(() => {
    setDraft("");
    setQueued(null);
    setAtts([]);
    setUploads([]);
    setError(null);
    sendingRef.current = false;
    flushBlockedRef.current = false;
  }, [sessionId]);

  useEffect(() => () => window.clearTimeout(errorTimer.current), []);

  const notifyError = useCallback((message: string) => {
    setError(message);
    window.clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => setError(null), ERROR_TTL_MS);
  }, []);

  const dismissError = useCallback(() => {
    window.clearTimeout(errorTimer.current);
    setError(null);
  }, []);

  const send = useCallback((): boolean => {
    const text = [draft.trim(), ...atts.map(attLine)].filter(Boolean).join("\n");
    if (!text) return false;
    if (running || sendingRef.current || queued) {
      // 单槽排队,后发覆盖先发(chip 可见,最新一条为准);用户主动再发
      // 也解除失败抑制,flush effect 在空闲时立即补投
      flushBlockedRef.current = false;
      setQueued(text);
      setDraft("");
      setAtts([]);
      return true;
    }
    sendingRef.current = true;
    const prevDraft = draft;
    const prevAtts = atts;
    setDraft("");
    setAtts([]);
    void sessionSend(sessionId, "user-input", { content: b64encode(text) })
      .then(() => {
        sendingRef.current = false;
      })
      .catch(() => {
        sendingRef.current = false;
        // 失败不丢草稿:文本回输入框、附件回 chips(壳契约 Err ⟺ 未入会话)。
        // 期间用户已敲了新内容/新附件则让位,不覆盖
        setDraft((cur) => (cur ? cur : prevDraft));
        setAtts((cur) => (cur.length ? cur : prevAtts));
      });
    return true;
  }, [draft, atts, queued, running, sessionId]);

  // 排队补投:轮结束(running 变 false)且无在途上行时发出
  useEffect(() => {
    if (running) {
      // 开轮 = 上一条上行已被壳接收;失败抑制也随轮次推进解除
      sendingRef.current = false;
      flushBlockedRef.current = false;
      return;
    }
    if (!queued || sendingRef.current || flushBlockedRef.current) return;
    const q = queued;
    sendingRef.current = true;
    setQueued(null);
    void sessionSend(sessionId, "user-input", { content: b64encode(q) })
      .then(() => {
        sendingRef.current = false;
      })
      .catch(() => {
        sendingRef.current = false;
        flushBlockedRef.current = true;
        // 失败回队;在途期间用户又排了新的,按单槽语义保留最新那条
        setQueued((cur) => cur ?? q);
      });
  }, [running, queued, sessionId]);

  const stop = useCallback(() => {
    void sessionSend(sessionId, "user-cancel", {}).catch(() => {});
  }, [sessionId]);

  /** 上传一个来源并入列附件;失败外显、不阻断后续文件。 */
  const uploadOne = useCallback(
    async (run: (onProgress: (sent: number, total: number) => void, signal: AbortSignal) => Promise<{ path: string }>, name: string, indeterminate: boolean, fallbackIsImage: boolean) => {
      const id = ++uploadSeqRef.current;
      const ctl = new AbortController();
      setUploads((list) => [
        ...list,
        {
          id,
          name,
          pct: indeterminate ? -1 : 0,
          ...(indeterminate ? {} : { cancel: () => ctl.abort() }),
        },
      ]);
      try {
        const { path } = await run((sent, total) => {
          // 封顶 99:最后一块落地后还有 finish(改名)在途,100% 由出列表达
          const pct = total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : 99;
          setUploads((list) => list.map((u) => (u.id === id ? { ...u, pct } : u)));
        }, ctl.signal);
        setAtts((list) => [
          ...list,
          {
            path,
            name: name || path.split("/").pop() || "file",
            isImage: fallbackIsImage || isImagePath(path),
          },
        ]);
      } catch (e) {
        if (!ctl.signal.aborted) {
          notifyError(t("chat.uploadFailed", { reason: e instanceof Error ? e.message : String(e) }));
        }
      } finally {
        setUploads((list) => list.filter((u) => u.id !== id));
      }
    },
    [notifyError],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      for (const f of files) {
        const native = nativePathOf(f);
        await uploadOne(
          (onProgress, signal) =>
            native
              ? uploadFilePath(sessionId, native)
              : uploadFileStream(sessionId, f, { onProgress, signal }),
          f.name,
          !!native || f.size === 0,
          f.type.startsWith("image/"),
        );
      }
    },
    [sessionId, uploadOne],
  );

  const addPaths = useCallback(
    async (paths: string[]) => {
      for (const p of paths) {
        const name = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
        await uploadOne(() => uploadFilePath(sessionId, p), name, true, false);
      }
    },
    [sessionId, uploadOne],
  );

  const removeAtt = useCallback((index: number) => {
    setAtts((list) => list.filter((_, i) => i !== index));
  }, []);

  const clearQueued = useCallback(() => setQueued(null), []);

  return {
    draft,
    setDraft,
    queued,
    clearQueued,
    atts,
    removeAtt,
    uploads,
    error,
    dismissError,
    notifyError,
    send,
    stop,
    addFiles,
    addPaths,
  };
}
