// 会话域 API:sessions_* / session_* / models_list 命令与 session-event 订阅。
// 类型字段名 = 壳侧 serde 序列化的线上形状(契约,别改名)。
// 浏览器模式:列表类返回空、变更类抛错(调用方 toast)。
import { inDesktopShell, invoke, listen } from "./ipc";

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
