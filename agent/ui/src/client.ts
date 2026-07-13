// 内核连接层:REST(会话管理)+ WS(帧双向流,含 call/call-response 同步查询)。
import type { Frame, SessionMeta } from "./types";

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
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json() as Promise<T>;
}

export const listSessions = () => api<SessionMeta[]>("/api/sessions");

export const createSession = (workdir: string, worktree: boolean) =>
  api<SessionMeta>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ workdir, worktree }),
  });

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
    sock.onopen = () => h.onStatus(`已连接 · 会话 ${sessionId}`, true);
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
