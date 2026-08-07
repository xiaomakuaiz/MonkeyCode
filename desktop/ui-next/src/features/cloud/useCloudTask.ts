// 云端任务详情的状态容器(简版,对齐移动端 task/[id].tsx 的数据流):
//   结束态(finished/error) → REST rounds 只读回放,"加载更早"按 cursor 往前翻;
//   启动中(pending)        → 轮询详情展示 VM 准备时间线,转 processing 后接流;
//   运行中(processing)     → WS attach(内核代理)回放当前轮 + 实时归约。
// 发送(简版):空闲直发——关掉观察连接,建 mode=new 连接(连上即上行首条
// 输入,经 stream 内部 send);失败经 onSendFailed 交还草稿,绝不静默丢。
// 执行中不排队(与旧 UI 投递队列的差异,刻意的简化):提示后保留草稿。
//
// 协议状态机(重连/退避/收束判定)全部在 lib/cloud/stream,本 hook 只做
// 编排:历史/当前轮帧缓存、归约回写、连接生命周期与轮询节奏。
// 契约:App 必须以 task.id 为 key 挂载视图(id 在一次挂载内不变)。
import { useCallback, useEffect, useRef, useState } from "react";

import { connectCloudControl, WAKE_CALL_TIMEOUT_MS } from "@/lib/cloud/control";
import { groupCloudModels, type McCloudModelGroup } from "@/lib/cloud/options";
import { chronoRounds } from "@/lib/cloud/rounds";
import {
  connectCloudStream,
  type CloudStreamConn,
  type StreamHandlers,
  type StreamStatus,
} from "@/lib/cloud/stream";
import { isImageFilename, MAX_CLOUD_ATTS, uploadCloudFile, type CloudUploadedAtt } from "@/lib/cloud/upload";
import { t } from "@/lib/i18n";
import type { FrameSender } from "@/lib/ipc/approvals";
import {
  mcTaskInfo,
  mcTaskOptions,
  mcTaskRounds,
  mcTaskStop,
  type CloudTask,
  type CloudTaskDetail,
} from "@/lib/ipc/cloudtasks";
import { frameData } from "@/lib/protocol/codec";
import { createChatState, prependHistory, reduceBatch } from "@/lib/protocol/reduce";
import type { ChatState, Frame, SlashCommand } from "@/lib/protocol/types";
import { withCommandSeparator } from "@/lib/util/slash";

/** 任务详情决定首屏数据源。运行中只能由 attach 回放当前轮;若同时用 REST
 * rounds 播种,迟到的 REST 快照会覆盖 attach 已归档的当前轮。 */
export function cloudInitialSource(status: string): "attach" | "rounds" | "pending" {
  if (status === "processing") return "attach";
  if (status === "finished" || status === "error") return "rounds";
  return "pending";
}

/** port_forward_list 条目(控制流内核代理;与 web 控制台同一形状)。 */
export interface PortInfo {
  port?: number;
  access_url?: string;
  label?: string;
  process?: string;
  status?: string;
}

export interface CloudTaskHandle {
  id: string;
  /** 任务详情(异步补全;VM 状态/模型/统计都在这) */
  meta: CloudTaskDetail | null;
  chat: ChatState;
  /** 连接状态(结构化;视图映射文案,健康态不外显) */
  status: StreamStatus | null;
  connected: boolean;
  /** attach 收束后的就绪态(发消息时另建 mode=new 连接) */
  idle: boolean;
  /** 操作失败/提示(视图横幅) */
  err: string;
  clearErr(): void;
  /** 视图侧动作失败入同一错误通道(如删除任务被服务端拒绝) */
  notifyErr(msg: string): void;
  /** 标题文案(task → meta 逐级回退) */
  label: string;
  taskStatus: string;
  ended: boolean;
  vmId: string;
  running: boolean;
  input: string;
  setInput(v: string): void;
  send(): void;
  /** 待发附件(上传已完成;发送时映射成 {url, filename} 随首条输入出线) */
  atts: CloudUploadedAtt[];
  /** 上传在途计数(>0 时发送被拦截并外显提示) */
  uploading: number;
  /** 逐个上传文件为附件(超限/失败经 err 外显;对话框/粘贴/拖拽共用) */
  addFiles(files: File[]): void;
  removeAtt(i: number): void;
  /** 模型分组投影(null = 未加载/加载失败;loadModels 幂等可重试) */
  models: McCloudModelGroup[] | null;
  loadModels(): void;
  switching: boolean;
  /** 经控制流 switch_model 切换模型(保留会话上下文;成败都刷新详情) */
  switchModel(modelId: string): Promise<void>;
  /** 中断当前执行(WS user-cancel,不终止任务;真布尔回执,失败外显) */
  cancelRun(): void;
  /** 审批/提问答复的上行发送面(适配 stream WS 的 send,封包归 stream;
   * 未连接或未送达 reject——卡片按失败回滚,不乐观假装已决)。 */
  sendFrame: FrameSender;
  /** 终止任务(REST stop;确认交互在视图) */
  stopTask(): Promise<void>;
  cursor: { cursor: string; hasMore: boolean } | null;
  loadingEarlier: boolean;
  /** 往更早翻 limit 轮(默认 1;壳侧上限 10)。大纲跳转补页用大步长
   * 减少跳到很早提问时的串行往返,"加载更早"按钮维持一次一轮。 */
  loadEarlier(limit?: number): Promise<void>;
  /** 斜杠指令清单(粘住最近一次非空:attach 重连/新一轮会以历史帧重算
   * chat 使 chat.commands 归零,菜单不该跟着空掉) */
  commands: SlashCommand[];
  /** VM 开放端口(null = 检测中/未拉过);access_url 可直接在浏览器打开 */
  ports: PortInfo[] | null;
  /** 拉一次开放端口(⋯ 菜单打开时触发;结束态/无 VM 不拉) */
  fetchPorts(): void;
  /** 已发出但云端还没回显的那条输入(mode=new 连接在途)。视图据此渲染
   * 「发送中」占位气泡——服务端回显要等 WS 连上(休眠机器要先唤醒,以分钟
   * 计),不占位的话输入框一清、日志无变化,用户会以为消息丢了 */
  sending: { content: string; attachments: { url: string; filename: string }[] } | null;
  /** 云端机器正在唤醒:服务端说 VM 休眠/离线,且我们正在连它。
   * 「连接中」与「唤醒中」的等待量级差一个数量级(秒 vs 分钟),文案要分开 */
  waking: boolean;
  /** VM 状态原值(unknown/pending/online/offline/hibernated) */
  vmStatus: string;
}

/** 服务端认定「机器不在线,连它要先唤醒」的 VM 状态(与后端
 * VirtualMachineStatus 同名值;空值 = 详情还没到,不妄断)。 */
const ASLEEP_VM = new Set(["hibernated", "offline"]);

export function useCloudTask(
  task: CloudTask,
  opts: { onTasksChanged?: () => void } = {},
): CloudTaskHandle {
  const id = task.id;
  const [meta, setMeta] = useState<CloudTaskDetail | null>(null);
  const [chat, setChat] = useState<ChatState>(createChatState);
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [idle, setIdle] = useState(false);
  const [err, setErr] = useState("");
  const [input, setInput] = useState("");
  const [atts, setAtts] = useState<CloudUploadedAtt[]>([]);
  const [uploading, setUploading] = useState(0);
  // 已发出、等云端回显的那条输入(mode=new 在途)。ref 与 state 并存:
  // onFrames 在连接回调闭包里跑,读 state 是陈旧的
  const [sending, setSending] = useState<CloudTaskHandle["sending"]>(null);
  const sendingRef = useRef(false);
  const clearSending = () => {
    if (!sendingRef.current) return;
    sendingRef.current = false;
    setSending(null);
  };
  // 附件占位计数走 ref:addFiles 的串行 async 循环里 state 闭包是陈旧的
  const attCountRef = useRef(0);
  // 斜杠指令清单粘住最近一次非空:清单是事件驱动的(available_commands_update),
  // attach 重连/新一轮以历史帧重算 chat 会让 chat.commands 归零,菜单不能跟着空
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [ports, setPorts] = useState<PortInfo[] | null>(null);
  const [models, setModels] = useState<McCloudModelGroup[] | null>(null);
  const [switching, setSwitching] = useState(false);
  const modelsInFlight = useRef(false);
  const modelsLoadedRef = useRef(false);
  const [cursor, setCursorState] = useState<{ cursor: string; hasMore: boolean } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // 游标/翻页互斥的权威读写走 ref:连续 await 间的 state 闭包是陈旧的
  const cursorRef = useRef<{ cursor: string; hasMore: boolean } | null>(null);
  const loadingRef = useRef(false);
  // 历史帧(已完成轮次)与当前轮实时帧分开:实时增量归约,重建时整体重算。
  // 不变式:live 只存"当前未结束轮"——轮一结束归档进 history,(重)建
  // attach 时清空 live 再由服务端整轮回放,天然不重复。
  const historyRef = useRef<Frame[]>([]);
  const liveRef = useRef<Frame[]>([]);
  const connRef = useRef<CloudStreamConn | null>(null);
  // attach 已收束(onIdle)后不自动重建:发消息走 mode=new;失败/唤醒经
  // epoch 重新武装
  const attachIdleRef = useRef(false);
  const [attachEpoch, setAttachEpoch] = useState(0);
  const onTasksChangedRef = useRef(opts.onTasksChanged);
  onTasksChangedRef.current = opts.onTasksChanged;

  const applyCursor = (c: { cursor: string; hasMore: boolean } | null) => {
    cursorRef.current = c;
    setCursorState(c);
  };

  const taskStatus = meta?.status ?? task.status ?? "pending";
  const ended = taskStatus === "finished" || taskStatus === "error";
  const vmId = meta?.virtualmachine?.id ?? "";
  const vmStatus = meta?.virtualmachine?.status ?? "";
  // 唤醒中 = 服务端说机器休眠/离线,而我们正在连它(发送在途或流在拨号)。
  // 只在服务端明说休眠时才敢讲「唤醒」;详情没到(vmStatus 空)按普通连接
  const waking =
    ASLEEP_VM.has(vmStatus) && !connected && (sending !== null || status?.kind === "connecting" || status?.kind === "reconnecting");
  const label = task.title || task.summary || task.content || meta?.title || meta?.summary || t("cloud.list.untitled");

  const refreshInfo = useCallback(async (): Promise<CloudTaskDetail | null> => {
    try {
      const info = await mcTaskInfo(id);
      setMeta(info);
      return info;
    } catch (e) {
      setErr(t("cloud.err.loadFailed", { reason: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  }, [id]);

  /** 连接回调(每次建连新做一份闭包;引用的全是稳定 setter/ref)。 */
  const makeHandlers = (): StreamHandlers => ({
    onFrames: (batch) => {
      const frames: Frame[] = [];
      let turnEnded = false;
      for (const f of batch) {
        if (f.type === "cursor") {
          // attach 下发的翻页游标:仅在尚未持有时采纳
          const c = frameData<{ cursor?: string; has_more?: boolean }>(f);
          if (c?.cursor && !cursorRef.current) applyCursor({ cursor: c.cursor, hasMore: !!c.has_more });
          continue;
        }
        if (f.type === "task-ended") turnEnded = true;
        frames.push(f);
      }
      if (!frames.length) return;
      // 云端开始回显(第一批实时帧里就有服务端回写的这条 user 消息):
      // 占位气泡让位给真气泡
      clearSending();
      liveRef.current.push(...frames);
      setChat((s) => reduceBatch(s, frames));
      if (turnEnded) {
        historyRef.current = [...historyRef.current, ...liveRef.current];
        liveRef.current = [];
      }
    },
    onStatus: (st, ok) => {
      setStatus(st);
      setConnected(ok);
      if (ok) setIdle(false);
    },
    // 一轮结束:刷新详情并让侧栏列表同步
    onEnded: () => void refreshInfo().then(() => onTasksChangedRef.current?.()),
    // 断线重连(降级 attach)会整轮回放当前轮:清本地当前轮缓存,回放为权威
    onReconnect: () => {
      liveRef.current = [];
      setChat(reduceBatch(createChatState(), historyRef.current));
    },
    // 空闲关闭/放弃重连:转就绪态,发消息时另建 mode=new 连接
    onIdle: () => {
      attachIdleRef.current = true;
      connRef.current = null;
      setConnected(false);
      setIdle(true);
      // 连接以「空闲」收束却一帧未回:发送态不能悬着(否则占位气泡永远转圈)。
      // 内容已经出门,不退回输入框——退回会造成重复发送
      clearSending();
    },
    // mode=new 首条输入未送达(拨号失败/零回显被关):草稿与附件都交还,
    // 绝不静默丢;重建 attach 拿回观察通道(被拒大多因为轮在跑)
    onSendFailed: (failed) => {
      connRef.current = null;
      clearSending(); // 内容回到输入框,占位气泡随之撤
      setInput((cur) => (cur ? failed.content + "\n" + cur : failed.content));
      const back = (failed.attachments ?? []).map((a) => ({ ...a, isImage: isImageFilename(a.filename) }));
      if (back.length) {
        attCountRef.current += back.length;
        setAtts((cur) => [...back, ...cur]);
      }
      setErr(t("cloud.err.sendRejected"));
      attachIdleRef.current = false;
      setAttachEpoch((e) => e + 1);
    },
  });

  // 进入任务:复位 + 拉详情;结束态走 REST rounds 回放。运行中不在这里碰
  // history——由下方 attach effect 独占当前轮,避免迟到的 REST 覆盖 WS 回放。
  useEffect(() => {
    historyRef.current = [];
    liveRef.current = [];
    attachIdleRef.current = false;
    setChat(createChatState());
    applyCursor(null);
    setErr("");
    setInput("");
    setAtts([]);
    attCountRef.current = 0;
    setIdle(false);
    sendingRef.current = false;
    setSending(null);
    let alive = true;
    void (async () => {
      const info = await refreshInfo();
      if (!alive || !info) return;
      if (cloudInitialSource(info.status ?? "") === "rounds") {
        try {
          const r = await mcTaskRounds(id, "", 1);
          if (!alive) return;
          historyRef.current = chronoRounds(r.frames ?? []);
          applyCursor(r.next_cursor ? { cursor: r.next_cursor, hasMore: !!r.has_more } : null);
          setChat(reduceBatch(createChatState(), historyRef.current));
        } catch (e) {
          setErr(t("cloud.err.loadFailed", { reason: e instanceof Error ? e.message : String(e) }));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, refreshInfo]);

  // 状态轮询:pending 3s(盯状态翻转),processing 10s(刷新元数据);结束停。
  useEffect(() => {
    if (ended) return;
    const timer = setInterval(() => void refreshInfo(), taskStatus === "pending" ? 3000 : 10000);
    return () => clearInterval(timer);
  }, [taskStatus, ended, refreshInfo]);

  // 运行中:WS attach 跟看。attachEpoch 驱动重建(发送失败后重新武装);
  // 已收束(attachIdleRef)或已有连接(发送切换的 mode=new)不重复建。
  useEffect(() => {
    if (cloudInitialSource(taskStatus) !== "attach") return;
    if (attachIdleRef.current || connRef.current) return;
    // attach 会整轮回放当前轮:清掉本地当前轮缓存,以服务端回放为权威
    liveRef.current = [];
    setChat(reduceBatch(createChatState(), historyRef.current));
    const conn = connectCloudStream(id, "attach", makeHandlers());
    connRef.current = conn;
    return () => {
      conn.close();
      if (connRef.current === conn) connRef.current = null;
    };
    // makeHandlers 引用的全是稳定 setter/ref,刻意不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, taskStatus, attachEpoch]);

  // 卸载兜底:发送切换出的 mode=new 连接不归 attach effect 管
  useEffect(
    () => () => {
      connRef.current?.close();
      connRef.current = null;
    },
    [],
  );

  const send = () => {
    // 整条恰是 `/<已知指令>` 时补尾随空格:云端按 `/name args` 解析,
    // 缺了这个分隔符整条会被当普通文本(与旧 UI 同一口径)
    const text = withCommandSeparator(input, commands);
    if (!text.trim() || ended) return;
    if (sendingRef.current) {
      // 上一条还在拨号(唤醒机器可能要几分钟):再发一次会 close 掉在途连接,
      // 首条经 onSendFailed 弹回输入框、把用户刚打的字挤掉。拦下并说明
      setErr(t("cloud.err.sendInFlight"));
      return;
    }
    if (chat.running) {
      // 简版:执行中不排队,提示并保留草稿(服务端运行互斥,抢发必被拒)
      setErr(t("cloud.err.roundRunning"));
      return;
    }
    if (uploading > 0) {
      // 上传没落定就发送,消息会带着半套附件出门:拦下并外显
      setErr(t("cloud.attach.uploadingWait"));
      return;
    }
    setErr("");
    setInput("");
    const attachments = atts.map(({ url, filename }) => ({ url, filename }));
    setAtts([]);
    attCountRef.current = 0;
    // 直发:当前轮并入历史,关掉观察连接,mode=new 连接连上即上行首条输入
    // (经 stream 内部 send;拨号失败/零回显被拒经 onSendFailed 交还草稿+附件)
    historyRef.current = [...historyRef.current, ...liveRef.current];
    liveRef.current = [];
    connRef.current?.close();
    attachIdleRef.current = true; // 由新连接接管;失败时 onSendFailed 重新武装
    setIdle(false);
    // 占位气泡立刻上屏:云端回显要等 WS 连上(休眠机器先唤醒,以分钟计)
    sendingRef.current = true;
    setSending({ content: text, attachments });
    // content 交明文:内层 base64 由 stream 状态机统一包(双重编码会乱码)
    connRef.current = connectCloudStream(id, "new", makeHandlers(), { content: text, attachments });
  };

  // 附件逐个上传(与本地会话 addFiles 语义对齐:超限/失败经 err 外显,
  // 成功即出现在待发条;上传中计数供发送拦截与 spinner)
  const addFiles = (files: File[]) => {
    if (ended) return;
    void (async () => {
      for (const f of files) {
        if (attCountRef.current >= MAX_CLOUD_ATTS) {
          setErr(t("cloud.attach.limit", { n: MAX_CLOUD_ATTS }));
          break;
        }
        attCountRef.current += 1;
        setUploading((n) => n + 1);
        try {
          const att = await uploadCloudFile(f);
          setAtts((prev) => [...prev, att]);
          setErr("");
        } catch (e) {
          attCountRef.current -= 1;
          setErr(t("cloud.attach.uploadFailed", { reason: e instanceof Error ? e.message : String(e) }));
        } finally {
          setUploading((n) => n - 1);
        }
      }
    })();
  };

  const removeAtt = (i: number) => {
    attCountRef.current = Math.max(0, attCountRef.current - 1);
    setAtts((prev) => prev.filter((_, j) => j !== i));
  };

  // 模型分组投影懒加载。幂等靠 inFlight ref 而非「已有值」:失败保持 null,
  // 重开菜单可重试(失败缓存 [] 会让本次挂载永远「没有可用模型」)
  const loadModels = useCallback(() => {
    if (modelsLoadedRef.current || modelsInFlight.current) return;
    modelsInFlight.current = true;
    mcTaskOptions()
      .then((o) => {
        modelsLoadedRef.current = true;
        setModels(groupCloudModels(o.models, o.plan));
      })
      .catch(() => undefined)
      .finally(() => {
        modelsInFlight.current = false;
      });
  }, []);

  useEffect(() => {
    if (chat.commands.length) setCommands(chat.commands);
  }, [chat.commands]);

  // 在线预览:⋯ 菜单打开时拉一次开放端口。控制流连接本身会唤醒休眠 VM,
  // 给足唤醒余量——默认 15s 在唤醒期间必超时,菜单会误显「没有开放的端口」
  const fetchPorts = () => {
    if (!vmId || ended) return;
    setPorts(null);
    const ctrl = connectCloudControl(id);
    ctrl
      .call<{ ports?: PortInfo[] }>("port_forward_list", {}, { timeoutMs: WAKE_CALL_TIMEOUT_MS, timeoutMsg: t("cloud.ctl.wakeTimeout") })
      .then((r) => setPorts(r.ports ?? []))
      .catch(() => setPorts([])) // 失败与「没开端口」同一呈现:菜单不留悬空 loading
      .finally(() => ctrl.close());
  };

  // 切换模型:经控制流调 switch_model(load_session=true 保留会话上下文)。
  // 临时建一条控制连接,用完即关(ui-next 无常驻控制流;连接本身会唤醒
  // 休眠 VM,给足唤醒余量,超时也不能断言失败——操作可能已在云端生效)
  const switchModel = async (modelId: string) => {
    if (switching || !modelId || modelId === meta?.model?.id) return;
    // locked(超会员档)条目菜单层已禁选,这里兜底防旁路
    if (models?.some((g) => g.models.some((m) => m.id === modelId && m.locked))) return;
    setSwitching(true);
    setErr("");
    const ctrl = connectCloudControl(id);
    try {
      await ctrl.call(
        "switch_model",
        { model_id: modelId, load_session: true },
        { timeoutMs: WAKE_CALL_TIMEOUT_MS, timeoutMsg: t("cloud.ctl.wakeTimeout") },
      );
    } catch (e) {
      setErr(t("cloud.model.switchFailed", { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      ctrl.close();
      setSwitching(false);
      void refreshInfo(); // 成败都刷新:超时路径的真实结果以详情为准
    }
  };

  // 审批/提问答复上行:适配 stream 的 send(b64(JSON) 封包在 stream 内统一
  // 做)成 FrameSender 契约——false/无连接一律 reject,卡片的失败回滚生效。
  // useCallback 空依赖:只读稳定 ref,注入下游(LogList)不随渲染变引用。
  const sendFrame: FrameSender = useCallback(async (ftype, payload) => {
    const conn = connRef.current;
    if (!conn) throw new Error("cloud stream not connected");
    const ok = await conn.send(ftype, payload);
    if (!ok) throw new Error("cloud frame not delivered");
  }, []);

  const cancelRun = () => {
    const conn = connRef.current;
    if (!conn) {
      setErr(t("cloud.err.cancelNotSent"));
      return;
    }
    // 等真实发送结果:同步假 true 会把"没送达"渲染成"已停止"
    void conn.send("user-cancel").then((ok) => {
      if (!ok) setErr(t("cloud.err.cancelNotSent"));
    });
  };

  const stopTask = async () => {
    try {
      await mcTaskStop(id);
      await refreshInfo();
      onTasksChangedRef.current?.();
    } catch (e) {
      setErr(t("cloud.err.stopFailed", { reason: e instanceof Error ? e.message : String(e) }));
    }
  };

  const loadEarlier = async (limit = 1) => {
    const cur = cursorRef.current;
    if (!cur || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingEarlier(true);
    try {
      const r = await mcTaskRounds(id, cur.cursor, limit);
      // 时序归一(lib/cloud/rounds):backward 批次轮间倒序,多轮直插会乱序
      const frames = chronoRounds(r.frames ?? []);
      historyRef.current = [...frames, ...historyRef.current];
      applyCursor(r.next_cursor && r.has_more !== false ? { cursor: r.next_cursor, hasMore: !!r.has_more } : null);
      setChat((s) => prependHistory(s, frames));
    } catch (e) {
      setErr(t("cloud.err.loadFailed", { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      loadingRef.current = false;
      setLoadingEarlier(false);
    }
  };

  return {
    id,
    meta,
    chat,
    status,
    connected,
    idle,
    err,
    clearErr: () => setErr(""),
    notifyErr: setErr,
    label,
    taskStatus,
    ended,
    vmId,
    running: chat.running && taskStatus === "processing",
    input,
    setInput,
    send,
    atts,
    uploading,
    addFiles,
    removeAtt,
    models,
    loadModels,
    switching,
    switchModel,
    cancelRun,
    sendFrame,
    stopTask,
    cursor,
    loadingEarlier,
    loadEarlier,
    commands,
    ports,
    fetchPorts,
    sending,
    waking,
    vmStatus,
  };
}
