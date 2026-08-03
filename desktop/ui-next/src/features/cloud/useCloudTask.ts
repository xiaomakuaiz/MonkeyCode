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

import {
  connectCloudStream,
  type CloudStreamConn,
  type StreamHandlers,
  type StreamStatus,
} from "@/lib/cloud/stream";
import { t } from "@/lib/i18n";
import type { FrameSender } from "@/lib/ipc/approvals";
import {
  mcTaskInfo,
  mcTaskRounds,
  mcTaskStop,
  type CloudTask,
  type CloudTaskDetail,
} from "@/lib/ipc/cloudtasks";
import { frameData } from "@/lib/protocol/codec";
import { createChatState, prependHistory, reduceBatch } from "@/lib/protocol/reduce";
import type { ChatState, Frame } from "@/lib/protocol/types";

/** 任务详情决定首屏数据源。运行中只能由 attach 回放当前轮;若同时用 REST
 * rounds 播种,迟到的 REST 快照会覆盖 attach 已归档的当前轮。 */
export function cloudInitialSource(status: string): "attach" | "rounds" | "pending" {
  if (status === "processing") return "attach";
  if (status === "finished" || status === "error") return "rounds";
  return "pending";
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
  /** 标题文案(task → meta 逐级回退) */
  label: string;
  taskStatus: string;
  ended: boolean;
  vmId: string;
  running: boolean;
  input: string;
  setInput(v: string): void;
  send(): void;
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
}

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
    },
    // mode=new 首条输入未送达(拨号失败/零回显被关):草稿交还输入框,
    // 绝不静默丢;重建 attach 拿回观察通道(被拒大多因为轮在跑)
    onSendFailed: (failed) => {
      connRef.current = null;
      setInput((cur) => (cur ? failed.content + "\n" + cur : failed.content));
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
    setIdle(false);
    let alive = true;
    void (async () => {
      const info = await refreshInfo();
      if (!alive || !info) return;
      if (cloudInitialSource(info.status ?? "") === "rounds") {
        try {
          const r = await mcTaskRounds(id, "", 1);
          if (!alive) return;
          historyRef.current = r.frames ?? [];
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
    const text = input;
    if (!text.trim() || ended) return;
    if (chat.running) {
      // 简版:执行中不排队,提示并保留草稿(服务端运行互斥,抢发必被拒)
      setErr(t("cloud.err.roundRunning"));
      return;
    }
    setErr("");
    setInput("");
    // 直发:当前轮并入历史,关掉观察连接,mode=new 连接连上即上行首条输入
    // (经 stream 内部 send;拨号失败/零回显被拒经 onSendFailed 交还草稿)
    historyRef.current = [...historyRef.current, ...liveRef.current];
    liveRef.current = [];
    connRef.current?.close();
    attachIdleRef.current = true; // 由新连接接管;失败时 onSendFailed 重新武装
    setIdle(false);
    // content 交明文:内层 base64 由 stream 状态机统一包(双重编码会乱码)
    connRef.current = connectCloudStream(id, "new", makeHandlers(), { content: text });
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
      const frames = r.frames ?? [];
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
    label,
    taskStatus,
    ended,
    vmId,
    running: chat.running && taskStatus === "processing",
    input,
    setInput,
    send,
    cancelRun,
    sendFrame,
    stopTask,
    cursor,
    loadingEarlier,
    loadEarlier,
  };
}
