// 内核连接层:REST(会话管理)+ WS(帧双向流,含 call/call-response 同步查询)。
// 帧载荷编解码在 codec.ts(纯函数,归约层与单测直接依赖那边)。
import { b64encode, frameData } from "./codec";
import type { Frame, HostConfig, ModelInfo, SessionMeta } from "./types";

export const token: string =
  location.hash.slice(1) || window.prompt("访问令牌(serve 启动时打印)") || "";

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

/** 删除会话(级联子会话与 worktree,不可恢复);运行中服务端拒绝(409)。 */
export const deleteSession = (id: string) =>
  api<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" });

/** 归档/取消归档会话。 */
export const setSessionArchived = (id: string, archived: boolean) =>
  api<SessionMeta>(`/api/sessions/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ archived }),
  });

/** 上传对话里粘贴/拖入的文件(图片或任意附件)到会话工作区 .mc-agent/uploads/,
 * 返回工作区相对路径。原始文件名尽量保留(内核清洗);剪贴板截图可传空名。 */
export const uploadFile = (sessionId: string, name: string, mediaType: string, dataB64: string) =>
  api<{ path: string }>(`/api/sessions/${sessionId}/uploads`, {
    method: "POST",
    body: JSON.stringify({ name, media_type: mediaType, data: dataB64 }),
  });

/** 已上传文件的回读 URL(<img>/下载无法带请求头,token 走查询参数)。 */
export function uploadFileURL(sessionId: string, path: string): string {
  const name = path.split("/").pop() ?? "";
  return `/api/sessions/${sessionId}/uploads/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`;
}

// ==================== 百智云账号(内核代理;凭证 cookie 不出内核) ====================

export interface BaizhiStatus {
  logged_in: boolean;
  host: string;
  profile?: Record<string, unknown>;
}

export const baizhiStatus = () => api<BaizhiStatus>("/api/baizhi/status");

export const baizhiSendCode = (phone: string) =>
  api<{ ok: boolean }>("/api/baizhi/send-code", {
    method: "POST",
    body: JSON.stringify({ phone }),
  });

export const baizhiLogin = (phone: string, code: string) =>
  api<{ ok: boolean }>("/api/baizhi/login", {
    method: "POST",
    body: JSON.stringify({ phone, code }),
  });

export const baizhiLogout = () =>
  api<{ ok: boolean }>("/api/baizhi/logout", { method: "POST" });

/** 发起微信扫码会话,返回二维码(data URL,直接给 <img>)。 */
export const baizhiWechatStart = () =>
  api<{ qr: string }>("/api/baizhi/wechat/start", { method: "POST" });

/** 长轮询一次扫码状态(内核侧最长挂 ~35s,拿到结果立即再调)。
 * status: waiting | scanned | canceled | expired | ok(ok 即登录完成)。 */
export const baizhiWechatPoll = () =>
  api<{ status: "waiting" | "scanned" | "canceled" | "expired" | "ok" }>("/api/baizhi/wechat/poll");

export interface BaizhiSyncedModel {
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  model: string;
  context_window?: number;
  vision?: boolean;
  source: string; // "baizhi"
}

export interface BaizhiSyncResult {
  models: BaizhiSyncedModel[];
  mcp_servers: Record<string, Record<string, unknown>>;
  key_created: boolean; // 本次是否在网关新建了密钥(false=复用已有)
  notes?: string[];
}

/** 同步模型网关的模型清单与推理密钥。knownKeys 传设置表单里已有的
 * api_key(能对上网关掩码就复用,避免每次同步都新建密钥)。
 * 返回结构供 UI 展示并合并进设置表单,由用户确认后保存。 */
export const baizhiSync = (knownKeys: string[]) =>
  api<BaizhiSyncResult>("/api/baizhi/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ known_keys: knownKeys }),
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

/** 是否 macOS 桌面壳(标题栏为 Overlay,侧栏顶部须为红绿灯预留拖拽区)。 */
export function isMacShell(): boolean {
  return inDesktopShell() && /Mac/.test(navigator.userAgent);
}

/** 是否 Windows 桌面壳(壳去掉了原生装饰栏,UI 须自绘 36px 标题栏)。 */
export function isWindowsShell(): boolean {
  return inDesktopShell() && /Windows/.test(navigator.userAgent);
}

// 窗口控制(自绘标题栏按钮用):core window 命令不带 label 即作用于调用方窗口。
// 关闭走壳的 CloseRequested 拦截 → 隐藏到托盘,与原生关闭按钮行为一致。

function windowCmd(cmd: string): Promise<unknown> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.core?.invoke) return Promise.reject(new Error("非桌面壳环境"));
  return tauri.core.invoke(`plugin:window|${cmd}`);
}

export const windowMinimize = () => windowCmd("minimize").catch(console.error);
export const windowToggleMaximize = () => windowCmd("toggle_maximize").catch(console.error);
export const windowClose = () => windowCmd("close").catch(console.error);

export async function windowIsMaximized(): Promise<boolean> {
  try {
    return (await windowCmd("is_maximized")) as boolean;
  } catch {
    return false;
  }
}

/** 监听窗口尺寸变化(最大化/还原图标切换用);返回解除监听函数。 */
export function onWindowResized(cb: () => void): () => void {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  const unlisten = tauri?.event?.listen?.("tauri://resize", cb);
  return () => void unlisten?.then((f) => f());
}

/** 宿主信息(应用版本等);非壳环境返回 null。 */
export async function getHostInfo(): Promise<{ version: string } | null> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.core?.invoke) return null;
  try {
    return (await tauri.core.invoke("host_info")) as { version: string };
  } catch {
    return null;
  }
}

export interface UpdateStatus {
  available: boolean;
  current?: string;
  latest?: string;
}

/** 检查应用更新(壳内可用);非壳环境或检查失败抛错。 */
export async function updateCheck(): Promise<UpdateStatus> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.core?.invoke) throw new Error("浏览器模式下不可用");
  return (await tauri.core.invoke("update_check")) as UpdateStatus;
}

/** 下载安装更新并重启应用(update_check 确认有新版后调用)。 */
export async function updateInstall(): Promise<void> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.core?.invoke) throw new Error("浏览器模式下不可用");
  await tauri.core.invoke("update_install");
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
  // 同 kind 并发排 FIFO(协议无请求 ID;服务端按帧序处理,应答与队列顺序一致)。
  // 双击文件夹/连点文件这类同 kind 并发若共用单槽会互相顶掉,悬到超时。
  interface PendingCall {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    dead?: boolean; // 已超时:留作墓碑吞掉对应应答,防止后续应答错位
  }
  const pending = new Map<string, PendingCall[]>();

  /** 断线/关闭时拒绝全部在途 call(应答不会再来,干等只会 15s 超时) */
  function failPending(msg: string) {
    for (const [, q] of pending) {
      for (const p of q) {
        clearTimeout(p.timer);
        if (!p.dead) p.reject(new Error(msg));
      }
    }
    pending.clear();
  }

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
      failPending("连接断开,请重试");
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
        const q = pending.get(f.kind);
        const p = q?.shift();
        if (q && q.length === 0) pending.delete(f.kind);
        if (p) {
          clearTimeout(p.timer);
          // 墓碑(已超时者)只吞应答不回调;坏载荷不能抛出,降级为空结果
          if (!p.dead) p.resolve(frameData(f) ?? {});
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
        const entry: PendingCall = {
          resolve: resolve as (v: unknown) => void,
          reject,
          // 超时不出队:应答仍会按序到达,置墓碑让它被吞掉,后续应答才不错位
          timer: setTimeout(() => {
            entry.dead = true;
            reject(new Error("call 超时"));
          }, CALL_TIMEOUT_MS),
        };
        const q = pending.get(kind);
        if (q) q.push(entry);
        else pending.set(kind, [entry]);
        ws.send(
          JSON.stringify({ type: "call", kind, data: b64encode(JSON.stringify(payload)), timestamp: Date.now() }),
        );
      });
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      failPending("连接已关闭");
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    },
  };
}
