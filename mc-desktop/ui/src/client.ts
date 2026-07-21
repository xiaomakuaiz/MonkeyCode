// 壳连接层:UI 只经 Tauri IPC 与桌面壳对话(invoke 上行 + event 下行),
// 壳内 driver 适配 agent 引擎;帧载荷编解码在 codec.ts。
//
// 事件通道(壳 → UI):
//   frames:{sid}       Frame[](批量;本地会话流,壳侧 ~30ms 聚合)
//   conn-status:{sid}  {text, connected} 会话流连接状态
//   session-event      {type: session-status|session-ask, ...} 全局会话状态
//   ws-msg:{pipe}      云端 WS 桥下行文本帧(stream/control/terminal 协议不变)
//   ws-closed:{pipe}   云端 WS 桥断开
//
// 导出签名与旧 HTTP/WS 版本保持一致,视图层零改动。
import { b64decode, b64encode } from "./codec";
import type { McTaskOptions } from "./cloud";
import type { Frame, HostConfig, ModelInfo, SessionMeta } from "./types";

interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
  event?: {
    listen?: (name: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
  };
}

function tauri(): TauriGlobal | undefined {
  return (window as { __TAURI__?: TauriGlobal }).__TAURI__;
}

/** invoke 封装:非壳环境(纯浏览器打开构建产物)直接报错。 */
function invoke<T>(cmd: string, args?: unknown): Promise<T> {
  const inv = tauri()?.core?.invoke;
  if (!inv) return Promise.reject(new Error("非桌面壳环境"));
  return inv(cmd, args) as Promise<T>;
}

/** 订阅壳事件;返回退订函数。listen 的注册是异步的,退订经 promise 链兜底。 */
function listen(name: string, cb: (payload: unknown) => void): () => void {
  const l = tauri()?.event?.listen;
  if (!l) return () => {};
  const un = l(name, (e) => cb(e.payload));
  return () => {
    un.then((f) => f()).catch(() => {});
  };
}

/** 等注册完成的订阅:壳在命令处理中同步 emit 的事件(会话回放、管道首帧)
 * 必须在监听注册落地后才发起命令,否则事件被丢不排队。 */
async function listenAsync(name: string, cb: (payload: unknown) => void): Promise<() => void> {
  const l = tauri()?.event?.listen;
  if (!l) throw new Error("非桌面壳环境");
  return l(name, (e) => cb(e.payload));
}

// ==================== 会话管理 ====================

export const listSessions = () => invoke<SessionMeta[]>("sessions_list");

export const listModels = () => invoke<ModelInfo[]>("models_list");

export const createSession = (workdir: string, model: string, createDir = false) =>
  invoke<SessionMeta>("session_create", { workdir, model, createDir });

/** 删除会话(级联子会话,不可恢复);运行中壳/内核拒绝。 */
export const deleteSession = (id: string) =>
  invoke<{ ok: boolean }>("session_delete", { id });

/** 重命名会话(标题非空,内核截断到 80 字符)。 */
export const setSessionTitle = (id: string, title: string) =>
  invoke<SessionMeta>("session_patch", { id, patch: { title } });

/** 归档/取消归档会话。 */
export const setSessionArchived = (id: string, archived: boolean) =>
  invoke<SessionMeta>("session_patch", { id, patch: { archived } });

/** 全局事件流:session-status(状态变更)/ session-ask(审批等待)。
 * 后台会话结束靠它感知(不轮询)。返回取消订阅函数。 */
export interface SessionEvent {
  type: string;
  id: string;
  title: string;
  /** session-status:新状态 */
  status?: string;
  /** session-ask:true 进入等待,false 解除 */
  open?: boolean;
}

export function subscribeEvents(onEvent: (e: SessionEvent) => void): () => void {
  return listen("session-event", (p) => onEvent(p as SessionEvent));
}

/** 引擎能力(UI 按此降级;引擎未运行时 reject)。 */
export interface EngineCaps {
  browser_ext: boolean;
  usage_update: boolean;
  perm_remember: boolean;
  attachments: boolean;
}

export const engineCaps = () => invoke<EngineCaps>("engine_caps");

/** 引擎崩溃信息(壳的进程监视发现非正常退出时推送)。 */
export interface EngineCrash {
  engine: string;
  detail: string;
  /** 引擎日志尾部(诊断展示) */
  log_tail?: string;
}

/** 订阅引擎崩溃事件;返回退订函数。 */
export function onEngineCrashed(cb: (info: EngineCrash) => void): () => void {
  return listen("engine-crashed", (p) => cb(p as EngineCrash));
}

/** 按当前配置重启引擎(崩溃恢复;成功后调用方整页刷新复位状态)。 */
export const engineRestart = () => invoke<void>("engine_restart");

// ==================== 附件 ====================

/** 上传对话里粘贴/拖入的文件(图片或任意附件)到会话工作区 .mc-agent/uploads/,
 * 返回工作区相对路径。原始文件名尽量保留(壳清洗);剪贴板截图可传空名。 */
export const uploadFile = (sessionId: string, name: string, mediaType: string, dataB64: string) =>
  invoke<{ path: string }>("upload_file", { id: sessionId, name, mediaType, data: dataB64 });

/** 已上传文件的回读 data URL(<img> 直接可用;壳读盘 base64 内联)。
 * 注意:异步(旧版是同步拼 URL);调用方 <img src> 前需 await。 */
export function uploadFileURL(sessionId: string, path: string): Promise<string> {
  return invoke<string>("upload_read", { id: sessionId, path });
}

// ==================== 浏览器扩展桥(壳内 browser/ 模块) ====================

/** browser_status 应答:扩展桥监听/配对/连接状态(设置页展示)。 */
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

export const getBrowserExtStatus = () => invoke<BrowserExtStatus>("browser_status");

/** 重置配对:吊销扩展长期凭据并生成新配对码(扩展侧需重新配对)。 */
export const repairBrowserExt = () => invoke<BrowserExtStatus>("browser_repair");

// ==================== 百智云账号(壳原生;凭证 cookie 不出壳进程) ====================

export interface BaizhiStatus {
  logged_in: boolean;
  host: string;
  profile?: Record<string, unknown>;
}

export const baizhiStatus = () => invoke<BaizhiStatus>("baizhi_status");

export const baizhiSendCode = (phone: string) =>
  invoke<{ ok: boolean }>("baizhi_send_code", { phone });

export const baizhiLogin = (phone: string, code: string) =>
  invoke<{ ok: boolean }>("baizhi_login", { phone, code });

export const baizhiLogout = () => invoke<{ ok: boolean }>("baizhi_logout");

/** 发起微信扫码会话,返回二维码(data URL,直接给 <img>)。 */
export const baizhiWechatStart = () => invoke<{ qr: string }>("baizhi_wechat_start");

/** 长轮询一次扫码状态(壳侧最长挂 ~40s,拿到结果立即再调)。
 * status: waiting | scanned | canceled | expired | ok(ok 即登录完成)。 */
export const baizhiWechatPoll = () =>
  invoke<{ status: "waiting" | "scanned" | "canceled" | "expired" | "ok" }>("baizhi_wechat_poll");

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
  invoke<BaizhiSyncResult>("baizhi_sync", { knownKeys });

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

export const mcStatus = () => invoke<McStatus>("mc_status");

/** 桥接登录:壳用已有的百智云会话走 OAuth 换 monkeycode 会话。
 * 未登录百智云或百智会话失效时报错。 */
export const mcLogin = () => invoke<{ ok: boolean; user?: McUser }>("mc_login");

export const mcLogout = () => invoke<{ ok: boolean }>("mc_logout");

export const mcTasks = (page = 1, size = 20, status = "") =>
  invoke<CloudTasksResp>("mc_tasks", { page, size, status });

/** 云端任务详情(ProjectTask 子集;VM 准备进度在 virtualmachine.conditions)。 */
export interface CloudTaskDetail extends CloudTask {
  model?: { id?: string; model?: string; remark?: string };
  branch?: string;
  repo_url?: string;
  full_name?: string;
  stats?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; llm_requests?: number };
  virtualmachine?: {
    id?: string;
    status?: string;
    conditions?: { type?: string; status?: number; message?: string; progress?: number }[];
  };
}

export const mcTaskInfo = (id: string) => invoke<CloudTaskDetail>("mc_task_info", { id });

/** 历史回放:壳已把云端 chunk 归一为 Frame 词汇(event→type,ns→ms)。
 * 一次一轮(对齐移动端);cursor 往更早翻。 */
export const mcTaskRounds = (id: string, cursor = "", limit = 1) =>
  invoke<{ frames: Frame[]; next_cursor?: string; has_more?: boolean }>("mc_task_rounds", {
    id,
    cursor,
    limit,
  });

/** 终止云端任务(区别于流上行 user-cancel:那只中断当前执行)。 */
export const mcTaskStop = (id: string) => invoke<{ ok: boolean }>("mc_task_stop", { id });

/** 创建云端任务(壳补默认值:公共宿主机/opencode/2核8G3小时/官方技能)。 */
export const mcTaskCreate = (req: {
  content: string;
  model_id: string;
  image_id: string;
  repo_url?: string;
  branch?: string;
  project_id?: string;
}) => invoke<CloudTaskDetail>("mc_task_create", { req });

export const mcTaskOptions = () => invoke<McTaskOptions>("mc_task_options");

// ==================== 云端 WS 桥(壳做纯文本管道,协议逻辑在本层) ====================

/** ws-closed 事件载荷:服务端 Close 帧的 code/reason(壳透传);
 * 异常断开(无 Close 帧)或壳侧主动断为 null。 */
export interface WsCloseInfo {
  code?: number;
  reason?: string;
}

/** 打开一条云端 WS 管道:onText 收下行文本帧,onClose 收断开(带服务端
 * 关闭原因,异常断开为 null)。
 * 返回 {send, close};open 失败时 reject。send 返回 Promise,发送失败会
 * reject(调用方决定如何外显——静默吞掉会让用户消息无声丢失)。
 * pipe id 由本层生成并**先注册监听再开管道**:attach 回放在连上瞬间就
 * 开始下发,监听后注册会丢头帧。 */
async function openPipe(
  kind: "stream" | "control" | "terminal",
  id: string,
  params: Record<string, unknown>,
  onText: (text: string) => void,
  onClose: (info: WsCloseInfo | null) => void,
): Promise<{ send(text: string): Promise<void>; close(): void }> {
  const pipe = crypto.randomUUID();
  let closed = false;
  const unMsg = await listenAsync(`ws-msg:${pipe}`, (p) => onText(p as string));
  const unClosed = await listenAsync(`ws-closed:${pipe}`, (p) => {
    if (closed) return;
    closed = true;
    unMsg();
    unClosed();
    onClose((p as WsCloseInfo | null) ?? null);
  });
  try {
    await invoke("cloud_ws_open", { kind, id, params, pipe });
  } catch (e) {
    unMsg();
    unClosed();
    throw e;
  }
  return {
    send(text: string) {
      return invoke("cloud_ws_send", { pipe, text });
    },
    close() {
      if (closed) return;
      closed = true;
      unMsg();
      unClosed();
      void invoke("cloud_ws_close", { pipe }).catch(() => {});
    },
  };
}

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
    /** 空闲关闭/连接彻底失败:云端对"当前轮已结束"的 attach 会直接关连接,
     * 这不是断线,不该重连——视图应转入"就绪"态(发消息时再建连接)。 */
    onIdle?(): void;
    /** mode=new 的首条输入未能送达(拨号失败):视图应把内容放回队列 */
    onSendFailed?(text: string): void;
  },
  firstInput?: string,
): CloudConn {
  let pipe: { send(t: string): Promise<void>; close(): void } | null = null;
  let closed = false;
  let ended = false;
  let lastSeq = 0;
  let queue: Frame[] = [];
  let flushScheduled = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFirst = firstInput;
  let curMode = mode;
  let attempt = 0;
  let openedThisAttempt = false; // 本次尝试是否成功建立过管道
  let framesThisOpen = 0; // 本次连接收到的业务帧数(区分"空闲关闭"与"断流")
  let dialFails = 0; // 连续拨号失败次数(指数退避,超限放弃)
  let dropCount = 0; // 连续短命断流次数(收过流又快速被关;超限转就绪兜底)
  let openedAt = 0; // 本次管道建立时刻(存活超 1 分钟视为健康,断流计数归零)
  let sentFirstText: string | null = null; // 已上行但尚无任何回显的首条输入

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
    if (!pipe) return false;
    // 管道死亡与 ws-closed 事件到达之间有窗口:发送失败必须外显,不能无声丢
    pipe
      .send(JSON.stringify({ type, data: b64encode(JSON.stringify(payload)), timestamp: Date.now() }))
      .catch(() => h.onStatus("⚠ 发送失败(云端连接中断),内容未送达", false));
    return true;
  };

  function onText(text: string) {
    let f: Frame;
    try {
      f = JSON.parse(text) as Frame;
    } catch {
      return;
    }
    if (f.type === "ping") return;
    // task-ended 判定先于 seq 去重:回放中控制帧可能把 seq 水位顶高,
    // 后到的 task-ended 会被当重叠帧丢弃,ended 永不置真 → 断开后被
    // 误判断流而无限重连
    if (f.type === "task-ended" && !ended) {
      ended = true;
      h.onEnded?.();
    }
    if (typeof f.seq === "number" && f.seq > 0) {
      if (f.seq <= lastSeq) return; // 重连回放重叠帧去重
      lastSeq = f.seq;
    }
    // cursor(翻页游标)/task-error(拒绝提示,含旧词 error)不算"轮活跃":
    // 空闲 attach 云端也会先发 cursor 再关连接,计入会让空闲关闭被误判
    // 成断流而无限重连
    if (f.type !== "cursor" && f.type !== "error" && f.type !== "task-error") {
      framesThisOpen += 1;
      sentFirstText = null; // 有回显 = 首条输入已被云端接收
    }
    queue.push(f);
    schedule();
  }

  function onPipeClose(info: WsCloseInfo | null = null) {
    pipe = null;
    if (closed) return;
    if (ended) {
      // task-ended 按轮下发:这里只代表本轮结束,任务是否终结以详情轮询为准
      h.onStatus("本轮已结束,可继续对话", false);
      return;
    }
    // 服务端正常关闭(Close 1000/1001)= 云端主动收束,不是断线:
    // 对"当前轮已结束"的 attach,云端回放完整轮帧后就正常关连接——
    // 只按 framesThisOpen 猜会误判成断流,陷入"重连→回放→被关"死循环
    const cleanClose = info?.code === 1000 || info?.code === 1001;
    if (openedThisAttempt && (cleanClose || framesThisOpen === 0)) {
      closed = true;
      if (sentFirstText !== null) {
        // mode=new 发了首条输入却零回显被关:大概率被拒(休眠/运行互斥),
        // 内容交还队列重试,绝不静默丢
        h.onSendFailed?.(sentFirstText);
        return;
      }
      // 云端收束/一帧未发就被关:停止重连,转"就绪"——发消息时会另建
      // mode=new 连接
      h.onIdle?.();
      return;
    }
    if (!openedThisAttempt) {
      dialFails += 1;
      if (pendingFirst !== undefined) {
        // 带首条输入的连接没拨通:内容交还视图排队,本连接就此作废
        const text = pendingFirst;
        pendingFirst = undefined;
        closed = true;
        h.onSendFailed?.(text);
        return;
      }
      if (dialFails >= 5) {
        // 连不上云端流(网络/环境异常):放弃自动重连,转就绪模式兜底
        closed = true;
        h.onStatus("⚠ 云端流连接失败,发送消息时会重试", false);
        h.onIdle?.();
        return;
      }
    } else {
      dialFails = 0; // 曾成功收流的断开:从头开始退避
      // 短命断流计数:这条路径没有拨号失败那样的自然上限,若服务端每次
      // 都在回放后快速关闭(且没带 Close 帧可识别),会永远 2 秒循环。
      // 存活超 1 分钟视为健康连接,计数归零;连续短命断流超限转就绪兜底
      if (Date.now() - openedAt > 60_000) dropCount = 0;
      dropCount += 1;
      if (dropCount >= 5) {
        closed = true;
        h.onStatus("⚠ 云端流反复断开,发送消息时会重试", false);
        h.onIdle?.();
        return;
      }
    }
    const delay = Math.min(2000 * 2 ** Math.max(0, dialFails - 1), 30_000);
    h.onStatus(`⚠ 云端连接断开,${Math.round(delay / 1000)} 秒后自动重连…`, false);
    curMode = "attach"; // 重连降级为跟看,避免误开新轮(对齐移动端)
    reconnectTimer = setTimeout(open, delay);
  }

  function open() {
    if (closed || ended) return;
    if (attempt > 0) {
      // 重连:回放将成为当前轮的权威来源,seq 水位一并复位
      h.onReconnect?.();
      lastSeq = 0;
    }
    attempt += 1;
    openedThisAttempt = false;
    framesThisOpen = 0;
    h.onStatus("连接云端…", false);
    openPipe("stream", taskId, { mode: curMode }, onText, onPipeClose)
      .then((p) => {
        if (closed) {
          p.close();
          return;
        }
        pipe = p;
        openedThisAttempt = true;
        openedAt = Date.now();
        dialFails = 0;
        h.onStatus("已连接云端", true);
        // 新一轮:云端等第一条 user-input 才开跑;content 需再包一层 base64
        if (pendingFirst !== undefined) {
          sentFirstText = pendingFirst;
          doSend("user-input", { content: b64encode(pendingFirst), attachments: [] });
          pendingFirst = undefined;
        }
      })
      .catch(() => onPipeClose());
  }

  open();
  return {
    send: doSend,
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      pipe?.close();
      pipe = null;
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
 * 未连上时发起的 call 排队等 open。服务端在连接建立时自动唤醒休眠 VM,
 * 连接存续期间保活(对齐 web 控制台机制)。 */
export function connectCloudControl(taskId: string): CloudControl {
  let pipe: { send(t: string): Promise<void>; close(): void } | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<string, Pending>();
  let sendQueue: string[] = []; // open 前排队的上行帧

  function onText(text: string) {
    let f: Frame;
    try {
      f = JSON.parse(text) as Frame;
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
  }

  function onPipeClose() {
    pipe = null;
    if (closed) return;
    reconnectTimer = setTimeout(open, 1500);
  }

  function open() {
    if (closed) return;
    openPipe("control", taskId, {}, onText, onPipeClose)
      .then((p) => {
        if (closed) {
          p.close();
          return;
        }
        pipe = p;
        const q = sendQueue;
        sendQueue = [];
        for (const m of q) void p.send(m).catch(() => {});
      })
      .catch(() => onPipeClose());
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
        if (pipe) {
          pipe.send(msg).catch(() => {
            const p = pending.get(requestID);
            if (p) {
              pending.delete(requestID);
              clearTimeout(p.timer);
              p.reject(new Error("云端连接已断开"));
            }
          });
        } else {
          sendQueue.push(msg);
        }
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
      pipe?.close();
      pipe = null;
    },
  };
}

/** 云端 VM 终端管道(cloudterm.tsx 用;协议:文本 JSON 帧 data/resize/ping,payload base64)。 */
export function connectCloudTerminal(
  vmId: string,
  terminalId: string,
  h: { onText(text: string): void; onClose(): void },
): Promise<{ send(text: string): Promise<void>; close(): void }> {
  return openPipe("terminal", vmId, { terminal_id: terminalId }, h.onText, h.onClose);
}

// ==================== 宿主(桌面壳)集成 ====================

/** 原生目录选择(桌面壳内可用);非壳环境或取消返回 null。
 * defaultPath:对话框初始位置(WSL 模式传发行版 UNC 根,否则默认落在
 * Windows 目录,选出来的路径环境不对)。 */
export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  if (!tauri()?.core?.invoke) return null;
  try {
    const r = await invoke<unknown>("plugin:dialog|open", {
      options: { directory: true, multiple: false, title: "选择工作区目录", ...(defaultPath ? { defaultPath } : {}) },
    });
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
}

/** 当前内核运行环境对应的目录对话框初始位置:WSL 模式返回发行版 UNC 根
 * (\\wsl$\<发行版>,老新 Windows 通吃),本机模式/读取失败返回 undefined。 */
export async function workdirPickBase(): Promise<string | undefined> {
  try {
    const env = (await getHostConfig())?.kernel_env ?? "";
    if (env.startsWith("wsl:") && env.length > 4) return `\\\\wsl$\\${env.slice(4)}`;
  } catch {
    /* 非壳或读取失败:不指定初始位置 */
  }
  return undefined;
}

/** 是否运行在桌面壳内。 */
export function inDesktopShell(): boolean {
  return !!tauri()?.core?.invoke;
}

/** 读取壳持有的应用配置(模型 + MCP);非壳环境返回 null。 */
export async function getHostConfig(): Promise<HostConfig | null> {
  if (!tauri()?.core?.invoke) return null;
  return invoke<HostConfig>("get_config");
}

/** 保存应用配置:壳写盘(0600)并重启引擎;resolve 后调用方整页刷新
 * (location.reload())以复位所有状态并重连。 */
export async function saveHostConfig(config: HostConfig): Promise<void> {
  if (!tauri()?.core?.invoke) throw new Error("浏览器模式下配置只读,请在桌面应用中修改");
  await invoke("save_config", { config });
}

/** 在文件管理器中定位随桌面包分发的浏览器扩展目录(用户在扩展管理页
 * 「加载已解压的扩展程序」时选它)。返回目录路径;非壳环境返回 null。 */
export async function openExtensionDir(): Promise<string | null> {
  if (!tauri()?.core?.invoke) return null;
  return invoke<string>("open_extension_dir");
}

/** 枚举 WSL 发行版(设置视图"运行环境"下拉用)。
 * 非壳环境、非 Windows 或未装 WSL 均返回空数组。 */
export async function listWslDistros(): Promise<string[]> {
  if (!tauri()?.core?.invoke) return [];
  try {
    return (await invoke<string[]>("list_wsl_distros")) ?? [];
  } catch {
    return [];
  }
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
  return invoke(`plugin:window|${cmd}`);
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
  return listen(name, () => cb());
}

/** 取走(消费)壳的待处理意图(如托盘"设置")。事件发后不管,页面未就绪时
 * 会丢;意图同时落在壳的待取状态,启动完成后经此补取。非壳环境返回 null。 */
export async function takeUiIntent(): Promise<string | null> {
  if (!tauri()?.core?.invoke) return null;
  try {
    return (await invoke<string | null>("take_ui_intent")) ?? null;
  } catch {
    return null;
  }
}

/** 宿主信息(应用版本等);非壳环境返回 null。 */
export async function getHostInfo(): Promise<{ version: string } | null> {
  if (!tauri()?.core?.invoke) return null;
  try {
    return await invoke<{ version: string }>("host_info");
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
  if (!tauri()?.core?.invoke) throw new Error("浏览器模式下不可用");
  return invoke<UpdateStatus>("update_check");
}

/** 下载安装更新并重启应用(update_check 确认有新版后调用)。 */
export async function updateInstall(): Promise<void> {
  if (!tauri()?.core?.invoke) throw new Error("浏览器模式下不可用");
  await invoke("update_install");
}

/** 在系统浏览器打开外部链接:壳内经 opener 插件,浏览器模式开新标签页。 */
export function openExternal(url: string): void {
  if (tauri()?.core?.invoke) {
    invoke("plugin:opener|open_url", { url }).catch((e) => {
      // 调用被拒(ACL/scope 配置问题)也不能毫无反应:退回整页导航,
      // 壳的 on_navigation 守卫会拒绝并转系统浏览器(Rust 侧不走 ACL)
      console.error("opener 调用失败,退回导航守卫路径:", e);
      location.href = url;
    });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

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
