// 本地会话域:会话 CRUD、全局会话事件、引擎能力/崩溃/重启、本地会话流
// (connect)。IPC 原语在 ipc.ts,载荷纯数据类型在 types.ts。
import { invoke, listen, listenAsync } from "./ipc";
import type { EngineCaps, EngineCrash, Frame, ModelInfo, SessionEvent, SessionMeta } from "./types";

// ==================== 会话管理 ====================

export const listSessions = () => invoke<SessionMeta[]>("sessions_list");

export const listModels = () => invoke<ModelInfo[]>("models_list");

export const createSession = (workdir: string, model: string, createDir = false, kind: "local" | "chat" = "local") =>
  invoke<SessionMeta>("session_create", { workdir, model, createDir, kind });

/** 删除会话(级联子会话,不可恢复);运行中壳/内核拒绝。 */
export const deleteSession = (id: string) =>
  invoke<{ ok: boolean }>("session_delete", { id });

/** 重命名会话(标题非空,内核截断到 80 字符)。 */
export const setSessionTitle = (id: string, title: string) =>
  invoke<{ ok: boolean }>("session_patch", { id, patch: { title } });

/** 归档/取消归档会话。 */
export const setSessionArchived = (id: string, archived: boolean) =>
  invoke<{ ok: boolean }>("session_patch", { id, patch: { archived } });

/** 订阅全局会话事件流(session-status / session-ask);返回取消订阅函数。 */
export function subscribeEvents(onEvent: (e: SessionEvent) => void): () => void {
  return listen("session-event", (p) => onEvent(p as SessionEvent));
}

export const engineCaps = () => invoke<EngineCaps>("engine_caps");

/** 订阅引擎崩溃事件;返回退订函数。 */
export function onEngineCrashed(cb: (info: EngineCrash) => void): () => void {
  return listen("engine-crashed", (p) => cb(p as EngineCrash));
}

/** 按当前配置重启引擎(崩溃恢复;成功后调用方整页刷新复位状态)。 */
export const engineRestart = () => invoke<void>("engine_restart");

// ==================== 本地会话流 ====================

export interface Conn {
  /** 上行一帧;resolve(false) = 发送失败(内容应保留供重试),并已经
   * onStatus 外显原因。 */
  send(type: string, payload: unknown): Promise<boolean>;
  call<T>(kind: string, payload?: unknown): Promise<T>;
  close(): void;
}

export interface ConnHandlers {
  onFrames(batch: Frame[]): void;
  onStatus(text: string, connected: boolean): void;
}

/**
 * 打开会话流:壳侧接引擎并按 ~30ms 批量推 frames:{sid} 事件(历史帧由
 * 引擎回放);断线由壳自动重连,状态经 conn-status:{sid} 事件透传。
 */
export function connect(sessionId: string, h: ConnHandlers): Conn {
  let closed = false;
  h.onStatus("连接中…", false);

  // 监听注册落地后才 session_open:壳在命令内同步回放历史帧并推送连接
  // 状态,监听未注册前的事件会被丢(不排队),表现为空对话/卡在"连接中"
  const unFramesP = listenAsync(`frames:${sessionId}`, (p) => {
    if (!closed) h.onFrames(p as Frame[]);
  });
  const unStatusP = listenAsync(`conn-status:${sessionId}`, (p) => {
    if (closed) return;
    const s = p as { text: string; connected: boolean };
    h.onStatus(s.text, s.connected);
  });
  Promise.all([unFramesP, unStatusP])
    .then(() => invoke("session_open", { id: sessionId }))
    .catch((e) => {
      if (!closed) h.onStatus("⚠ 打开会话失败: " + String(e), false);
    });
  const unlisten = () => {
    unFramesP.then((f) => f()).catch(() => {});
    unStatusP.then((f) => f()).catch(() => {});
  };

  return {
    async send(type, payload) {
      try {
        await invoke("session_send", { id: sessionId, ftype: type, payload });
        return true;
      } catch (e) {
        h.onStatus("⚠ " + String(e), false);
        return false;
      }
    },
    call<T>(kind: string, payload: unknown = {}): Promise<T> {
      // 统一入口:repo_* 由壳命令层分派到原生实现,UI 不感知执行方
      return invoke<T>("session_call", { id: sessionId, kind, payload });
    },
    close() {
      closed = true;
      unlisten();
      void invoke("session_close", { id: sessionId }).catch(() => {});
    },
  };
}
