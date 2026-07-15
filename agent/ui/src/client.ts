// 内核连接层:REST(会话管理)+ WS(帧双向流,含 call/call-response 同步查询)。
import type { Frame, HostConfig, ModelInfo, SessionMeta } from "./types";

export const token: string =
  location.hash.slice(1) || window.prompt("访问令牌(serve 启动时打印)") || "";

export function b64decode(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}

export function b64encode(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 解开帧 data(base64(JSON)) */
export function frameData<T = Record<string, unknown>>(f: Frame): T | null {
  if (!f.data) return null;
  try {
    return JSON.parse(b64decode(f.data)) as T;
  } catch {
    return null;
  }
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    let msg = "HTTP " + r.status;
    try {
      const body = (await r.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* 无 JSON 错误体 */
    }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export const listSessions = () => api<SessionMeta[]>("/api/sessions");

export const listModels = () => api<ModelInfo[]>("/api/models");

export const createSession = (workdir: string, model: string, createDir = false) =>
  api<SessionMeta>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ workdir, model, create_dir: createDir }),
  });

// ==================== 宿主(桌面壳)集成 ====================

interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
  event?: { listen?: (name: string, cb: () => void) => Promise<() => void> };
}

/** 原生目录选择(桌面壳内可用);非壳环境或取消返回 null。 */
export async function pickDirectory(): Promise<string | null> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.core?.invoke) return null;
  try {
    const r = await tauri.core.invoke("plugin:dialog|open", {
      options: { directory: true, multiple: false, title: "选择工作区目录" },
    });
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
}

/** 是否运行在桌面壳内。 */
export function inDesktopShell(): boolean {
  return !!(window as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke;
}

/** 读取壳持有的应用配置(模型 + MCP);非壳环境返回 null(浏览器模式只读)。 */
export async function getHostConfig(): Promise<HostConfig | null> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.core?.invoke) return null;
  return (await tauri.core.invoke("get_config")) as HostConfig;
}

/** 保存应用配置:壳写盘(0600)并重启内核,成功后本页面会被壳导航到新内核 URL。 */
export async function saveHostConfig(config: HostConfig): Promise<void> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.core?.invoke) throw new Error("浏览器模式下配置只读,请在桌面应用中修改");
  await tauri.core.invoke("save_config", { config });
}

/** 在系统浏览器打开外部链接:壳内经 opener 插件,浏览器模式开新标签页。 */
export function openExternal(url: string): void {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (tauri?.core?.invoke) {
    tauri.core.invoke("plugin:opener|open_url", { url }).catch((e) => {
      // 调用被拒(ACL/scope 配置问题)也不能毫无反应:退回整页导航,
      // 壳的 on_navigation 守卫会拒绝并转系统浏览器(Rust 侧不走 ACL)
      console.error("opener 调用失败,退回导航守卫路径:", e);
      location.href = url;
    });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** 订阅壳事件(如托盘"设置"),返回退订函数;非壳环境为空操作。 */
export function onHostEvent(name: string, cb: () => void): () => void {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  const listen = tauri?.event?.listen;
  if (!listen) return () => {};
  const un = listen(name, cb);
  return () => {
    un.then((f) => f()).catch(() => {});
  };
}

export interface Conn {
  send(type: string, payload: unknown): boolean;
  call<T>(kind: string, payload?: unknown): Promise<T>;
  close(): void;
}

export interface ConnHandlers {
  onFrames(batch: Frame[]): void;
  onStatus(text: string, connected: boolean): void;
}

const CALL_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 2_000;

/**
 * 打开会话 WS:帧按渲染帧批量上抛(高频流式帧逐条渲染会拖慢消费,
 * 服务端会按慢消费者断开);断线 2 秒自动重连,历史由服务端回放。
 */
export function connect(sessionId: string, h: ConnHandlers): Conn {
  let ws: WebSocket | null = null;
  let closed = false;
  let queue: Frame[] = [];
  let flushScheduled = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

  function flush() {
    flushScheduled = false;
    const batch = queue;
    queue = [];
    if (batch.length) h.onFrames(batch);
    if (queue.length) schedule();
  }
  function schedule() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(flush);
  }

  function open() {
    if (closed) return;
    h.onStatus("连接中…", false);
    const sock = new WebSocket(`ws://${location.host}/ws?session=${sessionId}&token=${token}`);
    ws = sock;
    // 会话 ID 是内部标识,对用户无信息量,状态只报连接结果
    sock.onopen = () => h.onStatus("已连接", true);
    sock.onclose = () => {
      if (ws !== sock || closed) return;
      h.onStatus("⚠ 连接断开,2 秒后自动重连…", false);
      reconnectTimer = setTimeout(open, RECONNECT_DELAY_MS);
    };
    sock.onmessage = (ev) => {
      let f: Frame;
      try {
        f = JSON.parse(ev.data as string) as Frame;
      } catch {
        return;
      }
      if (f.type === "call-response" && f.kind) {
        const p = pending.get(f.kind);
        if (p) {
          pending.delete(f.kind);
          clearTimeout(p.timer);
          p.resolve(f.data ? JSON.parse(b64decode(f.data)) : {});
          return;
        }
      }
      queue.push(f);
      schedule();
    };
  }

  open();
  return {
    send(type, payload) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        h.onStatus("⚠ 连接已断开,操作未发送;重连后请重试", false);
        return false;
      }
      ws.send(JSON.stringify({ type, data: b64encode(JSON.stringify(payload)), timestamp: Date.now() }));
      return true;
    },
    call<T>(kind: string, payload: unknown = {}): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("未连接"));
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(kind);
          reject(new Error("call 超时"));
        }, CALL_TIMEOUT_MS);
        pending.set(kind, { resolve: resolve as (v: unknown) => void, timer });
        ws.send(
          JSON.stringify({ type: "call", kind, data: b64encode(JSON.stringify(payload)), timestamp: Date.now() }),
        );
      });
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const [, p] of pending) clearTimeout(p.timer);
      pending.clear();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    },
  };
}
