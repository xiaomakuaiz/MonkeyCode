// 会话域 API:sessions_* / session_* / models_list 命令与 session-event 订阅。
// 类型字段名 = 壳侧 serde 序列化的线上形状(契约,别改名)。
// 浏览器模式:列表类返回空、变更类抛错(调用方 toast)。
import type { Frame } from "@/gen/Frame";
import { inDesktopShell, invoke, listen, listenAsync } from "./ipc";

export type SessionKind = "local" | "chat";

export interface SessionMeta {
  id: string;
  title: string;
  /** 引擎每轮异步生成的会话摘要(chat 空间列表的主行展示) */
  summary?: string;
  workdir: string;
  /** 会话空间;旧数据缺省为 local */
  kind?: SessionKind;
  model: string;
  /** 思考档位(off/low/medium/high;缺省 = 跟随模型默认) */
  think?: string;
  /** 权限模式("yolo" 全放行;缺省 = default) */
  mode?: string;
  turns: number;
  status: string;
  /** 有待答复的审批请求(运行时状态,不落盘) */
  waiting_ask?: boolean;
  updated_at?: string;
  archived?: boolean;
}

export interface ModelInfo {
  name: string;
  default: boolean;
  /** 条目来源("baizhi"=百智云同步);缺省=手工添加 */
  source?: string;
  model?: string;
  locked?: boolean;
  owner?: string;
  think?: string;
}

/** 全局 session-event 载荷:session-status / session-ask / session-summary。 */
export interface SessionEvent {
  type: string;
  id: string;
  title: string;
  status?: string;
  open?: boolean;
  summary?: string;
}

export function sessionsList(): Promise<SessionMeta[]> {
  if (!inDesktopShell()) return Promise.resolve([]);
  return invoke<SessionMeta[]>("sessions_list").catch(() => []);
}

export function modelsList(): Promise<ModelInfo[]> {
  if (!inDesktopShell()) return Promise.resolve([]);
  return invoke<ModelInfo[]>("models_list").catch(() => []);
}

export function sessionCreate(args: {
  workdir: string;
  model: string;
  createDir: boolean;
  kind?: SessionKind;
  think?: string;
}): Promise<SessionMeta> {
  return invoke<SessionMeta>("session_create", args);
}

export function sessionDelete(id: string): Promise<void> {
  return invoke<{ ok: boolean }>("session_delete", { id }).then(() => {});
}

/** patch 支持 {title} 与 {archived}(壳侧白名单)。 */
export function sessionPatch(id: string, patch: { title?: string; archived?: boolean }): Promise<void> {
  return invoke<{ ok: boolean }>("session_patch", { id, patch }).then(() => {});
}

/** 后台会话状态/摘要/审批等待的全局事件(不轮询)。 */
export function onSessionEvent(cb: (e: SessionEvent) => void): () => void {
  return listen<SessionEvent>("session-event", cb);
}

/* ---- 会话打开/回放/收发(聊天视图数据面) ---- */


export interface SessionWindow {
  frames: Frame[];
  cursor: number;
  has_more: boolean;
}

/** ⚠️ session_history 的返回形状与 session_open **不同**:游标叫
 *  `next_cursor`(壳 session.rs 两处 json! 字面量),按 `cursor` 取会拿到
 *  undefined,首次翻页后游标即坏死——两个形状必须分开建型。 */
export interface HistoryPage {
  frames: Frame[];
  next_cursor: number;
  has_more: boolean;
}

/** ⚠️ 铁律「监听先于命令」:壳在 session_open 处理中同步 emit 首批实时帧,
 *  调用方必须先 `await onFrames(id, cb)` 再调本函数,否则丢帧。 */
export function sessionOpen(id: string): Promise<SessionWindow> {
  return invoke<SessionWindow>("session_open", { id });
}

/** 往更早翻页(前插历史);cursor 来自 session_open 的 cursor 或上一页的
 *  next_cursor(replay.jsonl 字节偏移,与 session_outline 的 offset 同坐标系)。 */
export function sessionHistory(id: string, cursor: number, limit: number): Promise<HistoryPage> {
  return invoke<HistoryPage>("session_history", { id, cursor, limit });
}

/** 回读单帧原文(工具卡被截断的大字段按需取)。 */
export function sessionFrame(id: string, seq: number): Promise<Frame> {
  return invoke<Frame>("session_frame", { id, seq });
}

export function sessionClose(id: string): Promise<void> {
  return invoke<void>("session_close", { id }).catch(() => {});
}

/** 发帧(ftype="user-input" 等;payload 形状由帧词汇决定)。 */
export function sessionSend(id: string, ftype: string, payload: Record<string, unknown>): Promise<void> {
  return invoke<void>("session_send", { id, ftype, payload });
}

/** 实时帧通道(壳侧 ~30ms 批量聚合)。返回注册完成的退订。 */
export function onFrames(id: string, cb: (frames: Frame[]) => void): Promise<() => void> {
  return listenAsync<Frame[]>(`frames:${id}`, cb);
}

export interface ConnStatus {
  text: string;
  connected: boolean;
}

export function onConnStatus(id: string, cb: (s: ConnStatus) => void): Promise<() => void> {
  return listenAsync<ConnStatus>(`conn-status:${id}`, cb);
}
