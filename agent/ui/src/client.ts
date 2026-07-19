// 内核连接层:REST(会话管理)+ WS(帧双向流,含 call/call-response 同步查询)。
// 帧载荷编解码在 codec.ts(纯函数,归约层与单测直接依赖那边)。
import { b64decode, b64encode, frameData } from "./codec";
import type { McTaskOptions } from "./cloud";
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

/** /api/events 下行事件:session-status(状态变更)/ session-ask(审批等待) */
export interface SessionEvent {
  type: string;
  id: string;
  title: string;
  /** session-status:新状态 */
  status?: string;
  /** session-ask:true 进入等待,false 解除 */
  open?: boolean;
}

/** 订阅全局事件流(SSE):会话状态变更推送,后台会话结束靠它感知(不轮询)。
 * EventSource 加不了请求头,token 走查询参数;断线自动重连。返回取消订阅函数。 */
export function subscribeEvents(onEvent: (e: SessionEvent) => void): () => void {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data as string) as SessionEvent);
    } catch {
      /* 非 JSON 数据行忽略 */
    }
  };
  return () => es.close();
}

export const listModels = () => api<ModelInfo[]>("/api/models");

export const createSession = (workdir: string, model: string, createDir = false) =>
  api<SessionMeta>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ workdir, model, create_dir: createDir }),
  });

/** 删除会话(级联子会话与 worktree,不可恢复);运行中服务端拒绝(409)。 */
export const deleteSession = (id: string) =>
  api<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" });

/** 重命名会话(标题非空,内核截断到 80 字符)。 */
export const setSessionTitle = (id: string, title: string) =>
  api<SessionMeta>(`/api/sessions/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });

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

// ==================== 浏览器扩展桥(内核进程级状态) ====================

/** /api/browser/status 应答:扩展桥监听/配对/连接状态(设置页展示)。 */
export interface BrowserExtStatus {
  enabled: boolean;
  addr?: string;
  error?: string;
  paired: boolean;
  connected: boolean;
  browser_name?: string;
  browser_version?: string;
  /** 未配对时的一次性配对码(用户填进扩展 options 完成配对) */
  pairing_code?: string;
}

export const getBrowserExtStatus = () => api<BrowserExtStatus>("/api/browser/status");

/** 重置配对:吊销扩展长期凭据并生成新配对码(扩展侧需重新配对)。 */
export const repairBrowserExt = () =>
  api<BrowserExtStatus>("/api/browser/repair", { method: "POST" });

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
  key_name?: string; // 使用的密钥在网关里的名字(撞名时是 MonkeyCode-N)
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

// ==================== MonkeyCode 云端(百智会话桥接;凭证不出内核) ====================

export interface McUser {
  id?: string;
  name?: string;
  username?: string;
  email?: string;
  avatar_url?: string;
}

export interface McStatus {
  logged_in: boolean;
  /** 云端主机名(拼任务详情外链用,如 monkeycode-ai.com) */
  host: string;
  user?: McUser;
}

/** 云端任务(backend ProjectTask 的侧栏子集,字段与云端 JSON 一致)。
 * 实测线上 title 常为空、任务文案落在 summary,展示优先 title → summary → content。 */
export interface CloudTask {
  id: string;
  title?: string;
  summary?: string;
  content?: string;
  status?: "pending" | "processing" | "error" | "finished";
  created_at?: number;
}

export interface CloudTasksResp {
  tasks?: CloudTask[];
  page_info?: { total?: number; total_count?: number };
}

export const mcStatus = () => api<McStatus>("/api/mc/status");

/** 桥接登录:内核用已有的百智云会话走 OAuth 换 monkeycode 会话。
 * 未登录百智云或百智会话失效时报错(HTTP 401)。 */
export const mcLogin = () =>
  api<{ ok: boolean; user?: McUser }>("/api/mc/login", { method: "POST" });

export const mcLogout = () =>
  api<{ ok: boolean }>("/api/mc/logout", { method: "POST" });

export const mcTasks = (page = 1, size = 20, status = "") =>
  api<CloudTasksResp>(
    `/api/mc/tasks?page=${page}&size=${size}${status ? `&status=${encodeURIComponent(status)}` : ""}`,
  );

/** 云端任务详情(ProjectTask 子集;VM 准备进度在 virtualmachine.conditions)。 */
export interface CloudTaskDetail extends CloudTask {
  model?: { id?: string; model?: string; remark?: string };
  branch?: string;
  repo_url?: string;
  full_name?: string;
  stats?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; llm_requests?: number };
  virtualmachine?: {
    id?: string;
    conditions?: { type?: string; status?: number; message?: string; progress?: number }[];
  };
}

export const mcTaskInfo = (id: string) => api<CloudTaskDetail>(`/api/mc/tasks/${encodeURIComponent(id)}`);

/** 历史回放:内核已把云端 chunk 归一为 Frame 词汇(event→type,ns→ms)。
 * 一次一轮(对齐移动端);cursor 往更早翻。 */
export const mcTaskRounds = (id: string, cursor = "", limit = 1) =>
  api<{ frames: Frame[]; next_cursor?: string; has_more?: boolean }>(
    `/api/mc/tasks/${encodeURIComponent(id)}/rounds?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );

/** 终止云端任务(REST;区别于流上行 user-cancel:那只中断当前执行)。 */
export const mcTaskStop = (id: string) =>
  api<{ ok: boolean }>(`/api/mc/tasks/${encodeURIComponent(id)}/stop`, { method: "POST" });

/** 创建云端任务(内核补默认值:公共宿主机/opencode/2核8G3小时/官方技能)。 */
export const mcTaskCreate = (req: {
  content: string;
  model_id: string;
  image_id: string;
  repo_url?: string;
  branch?: string;
  project_id?: string;
}) => api<CloudTaskDetail>("/api/mc/tasks", { method: "POST", body: JSON.stringify(req) });

export const mcTaskOptions = () => api<McTaskOptions>("/api/mc/task-options");

export interface CloudConn {
  /** 上行一帧(payload 会 base64(JSON) 包装);未连接返回 false。 */
  send(type: string, payload?: unknown): boolean;
  close(): void;
}

/** 连接云端任务流(内核代理:内核带 monkeycode 会话拨 wss 到云端)。
 * mode=attach 回放当前轮+实时跟看;mode=new 开新一轮(连上即发 firstInput)。
 * 帧结构与本地会话 Frame 同构,可直接喂 reduceBatch;ping 已滤除,seq 单调去重。
 * 断线自动重连(降级 attach);收到 task-ended 后不再重连并回调 onEnded。 */
export function connectCloudTask(
  taskId: string,
  mode: "attach" | "new",
  h: {
    onFrames(batch: Frame[]): void;
    onStatus(text: string, connected: boolean): void;
    onEnded?(): void;
    /** 断线重连前回调:attach 会整轮回放当前轮,视图应清掉当前轮本地缓存 */
    onReconnect?(): void;
  },
  firstInput?: string,
): CloudConn {
  let ws: WebSocket | null = null;
  let closed = false;
  let ended = false;
  let lastSeq = 0;
  let queue: Frame[] = [];
  let flushScheduled = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFirst = firstInput;
  let curMode = mode;
  let attempt = 0;

  function flush() {
    flushScheduled = false;
    const batch = queue;
    queue = [];
    if (batch.length) h.onFrames(batch);
  }
  function schedule() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(flush);
  }

  const doSend = (type: string, payload: unknown = {}) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type, data: b64encode(JSON.stringify(payload)), timestamp: Date.now() }));
    return true;
  };

  function open() {
    if (closed || ended) return;
    if (attempt > 0) {
      // 重连:回放将成为当前轮的权威来源,seq 水位一并复位
      h.onReconnect?.();
      lastSeq = 0;
    }
    attempt += 1;
    h.onStatus("连接云端…", false);
    const sock = new WebSocket(
      `ws://${location.host}/api/mc/tasks/${encodeURIComponent(taskId)}/stream?mode=${curMode}&token=${encodeURIComponent(token)}`,
    );
    ws = sock;
    sock.onopen = () => {
      h.onStatus("已连接云端", true);
      // 新一轮:云端等第一条 user-input 才开跑;content 需再包一层 base64
      if (pendingFirst !== undefined) {
        doSend("user-input", { content: b64encode(pendingFirst), attachments: [] });
        pendingFirst = undefined;
      }
    };
    sock.onclose = () => {
      if (ws !== sock || closed) return;
      if (ended) {
        // task-ended 按轮下发:这里只代表本轮结束,任务是否终结以详情轮询为准
        h.onStatus("本轮已结束,可继续对话", false);
        return;
      }
      h.onStatus("⚠ 云端连接断开,2 秒后自动重连…", false);
      curMode = "attach"; // 重连降级为跟看,避免误开新轮(对齐移动端)
      reconnectTimer = setTimeout(open, 2000);
    };
    sock.onmessage = (ev) => {
      let f: Frame;
      try {
        f = JSON.parse(ev.data as string) as Frame;
      } catch {
        return;
      }
      if (f.type === "ping") return;
      if (typeof f.seq === "number" && f.seq > 0) {
        if (f.seq <= lastSeq) return; // 重连回放重叠帧去重
        lastSeq = f.seq;
      }
      if (f.type === "task-ended") ended = true;
      queue.push(f);
      schedule();
      if (f.type === "task-ended") h.onEnded?.();
    };
  }

  open();
  return {
    send: doSend,
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    },
  };
}

// ---- 云端控制流(文件树/读文件/改动/diff/端口;call 按 request_id 配对) ----

/** repo_file_list 条目;entry_mode 4=目录 5=子模块(对齐 web task-shared.ts) */
export interface CloudRepoFile {
  name: string;
  path: string;
  entry_mode: number;
  size?: number;
  modified_at?: number;
}

export interface CloudFileChange {
  path: string;
  status: string; // M/A/D/R/RM/??
  additions?: number;
  deletions?: number;
  old_path?: string;
}

export interface CloudControl {
  /** 发一次 call(kind + payload),按 request_id 等待应答;失败 reject(error)。 */
  call<T>(kind: string, payload?: Record<string, unknown>): Promise<T>;
  close(): void;
}

const CONTROL_CALL_TIMEOUT_MS = 15_000;

/** 连接云端任务控制流(内核代理)。长生命周期,断线 1.5s 自动重连;
 * 未连上时发起的 call 排队等 open。 */
export function connectCloudControl(taskId: string): CloudControl {
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<string, Pending>();
  let sendQueue: string[] = []; // open 前排队的上行帧

  function open() {
    if (closed) return;
    const sock = new WebSocket(
      `ws://${location.host}/api/mc/tasks/${encodeURIComponent(taskId)}/control?token=${encodeURIComponent(token)}`,
    );
    ws = sock;
    sock.onopen = () => {
      const q = sendQueue;
      sendQueue = [];
      for (const m of q) sock.send(m);
    };
    sock.onclose = () => {
      if (ws !== sock || closed) return;
      reconnectTimer = setTimeout(open, 1500);
    };
    sock.onmessage = (ev) => {
      let f: Frame;
      try {
        f = JSON.parse(ev.data as string) as Frame;
      } catch {
        return;
      }
      if (f.type !== "call-response" || !f.data) return;
      let resp: { request_id?: string; success?: boolean; error?: string } & Record<string, unknown>;
      try {
        resp = JSON.parse(b64decode(f.data));
      } catch {
        return;
      }
      const p = resp.request_id ? pending.get(resp.request_id) : undefined;
      if (!p) return;
      pending.delete(resp.request_id!);
      clearTimeout(p.timer);
      if (resp.success === false) p.reject(new Error(resp.error || "云端操作失败"));
      else p.resolve(resp);
    };
  }

  open();
  return {
    call<T>(kind: string, payload: Record<string, unknown> = {}): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (closed) return reject(new Error("连接已关闭"));
        const requestID = crypto.randomUUID();
        const msg = JSON.stringify({
          type: "call",
          kind,
          data: b64encode(JSON.stringify({ request_id: requestID, ...payload })),
        });
        pending.set(requestID, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer: setTimeout(() => {
            pending.delete(requestID);
            reject(new Error("云端操作超时"));
          }, CONTROL_CALL_TIMEOUT_MS),
        });
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
        else sendQueue.push(msg);
      });
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("连接已关闭"));
      }
      pending.clear();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    },
  };
}

/** 云端 VM 终端 WS 地址(内核代理;协议:文本 JSON 帧 data/resize/ping,payload base64)。 */
export function cloudTerminalURL(vmId: string, terminalId: string): string {
  return `ws://${location.host}/api/mc/vms/${encodeURIComponent(vmId)}/terminal?terminal_id=${encodeURIComponent(terminalId)}&token=${encodeURIComponent(token)}`;
}

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

/** 在文件管理器中定位随桌面包分发的浏览器扩展目录(用户在扩展管理页
 * 「加载已解压的扩展程序」时选它)。返回目录路径;非壳环境返回 null。 */
export async function openExtensionDir(): Promise<string | null> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.core?.invoke) return null;
  return (await tauri.core.invoke("open_extension_dir")) as string;
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
export const onWindowResized = (cb: () => void): (() => void) => onHostEvent("tauri://resize", cb);

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

/** 取走(消费)壳的待处理意图(如托盘"设置")。事件发后不管,页面未就绪时
 * 会丢;意图同时落在壳的待取状态,启动完成后经此补取。非壳环境返回 null。 */
export async function takeUiIntent(): Promise<string | null> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.core?.invoke) return null;
  try {
    return ((await tauri.core.invoke("take_ui_intent")) as string | null) ?? null;
  } catch {
    return null;
  }
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
