// 云端任务详情视图:在桌面内回放/跟看/操作 monkeycode 云端任务,不开浏览器。
// 数据流对齐移动端 task/[id].tsx:
//   结束态(finished/error) → REST rounds 只读回放,"加载更早"按 cursor 往前翻;
//   启动中(pending)        → 轮询详情展示 VM 准备进度,转 processing 后接流;
//   运行中(processing)     → WS attach(内核代理)回放当前轮 + 实时;发消息切 mode=new。
// 渲染复用本地会话的帧归约链(reduceBatch → LogList):云端帧与本地 Frame 同构。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectCloudControl,
  connectCloudTask,
  mcTaskInfo,
  mcTaskOptions,
  mcTaskRounds,
  mcTaskStop,
  openExternal,
  type CloudConn,
  type CloudTask,
  type CloudTaskDetail,
} from "./client";
import { cloudModelLabel, usableCloudModels, type McCloudModel } from "./cloud";
import { CloudFilesDrawer } from "./cloudfiles";
import { CloudTerminal } from "./cloudterm";
import { b64decode } from "./codec";
import { COL_MAX, isImeEnter, markImeEnd } from "./chat";
import { LogList, TaskPanel } from "./components";
import { IconCheck, IconChevronDown, IconClock, IconCloud, IconDots, IconFolder, IconGlobe, IconMonitor, IconSend, IconStop, IconX } from "./icons";
import { answerAsk, initialChat, reduceBatch, type ChatState } from "./reduce";
import type { Frame } from "./types";

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  pending: { text: "排队中", color: "var(--warn)" },
  processing: { text: "运行中", color: "var(--acc)" },
  error: { text: "出错", color: "var(--err)" },
  finished: { text: "已完成", color: "var(--t4)" },
};

/** cursor 帧载荷:attach 下发时 data 可能是裸 JSON 对象,也可能是 base64(JSON) */
function parseCursor(f: Frame): { cursor?: string; has_more?: boolean } | null {
  const d = f.data as unknown;
  if (!d) return null;
  if (typeof d === "object") return d as { cursor?: string; has_more?: boolean };
  if (typeof d !== "string") return null;
  try {
    return JSON.parse(b64decode(d)) as { cursor?: string; has_more?: boolean };
  } catch {
    try {
      return JSON.parse(d) as { cursor?: string; has_more?: boolean };
    } catch {
      return null;
    }
  }
}

/** VM 准备进度:取 conditions 最后一项(对齐移动端 taskConditionInfo) */
function vmCondition(meta: CloudTaskDetail | null): string {
  const conds = meta?.virtualmachine?.conditions;
  const last = conds?.[conds.length - 1];
  if (!last) return "云端开发环境准备中…";
  const label: Record<string, string> = {
    Scheduled: "已调度",
    ImagePulled: "拉取镜像",
    ProjectCloned: "克隆代码",
    ImageBuilt: "构建镜像",
    ContainerCreated: "创建容器",
    ContainerStarted: "启动容器",
    Ready: "环境就绪",
    Failed: "环境启动失败",
  };
  const name = label[last.type ?? ""] ?? last.type ?? "准备中";
  const pct = typeof last.progress === "number" && last.progress > 0 ? ` ${last.progress}%` : "";
  return `云端开发环境:${name}${pct}${last.message ? ` — ${last.message}` : ""}`;
}

export function CloudTaskView({
  task,
  mcHost,
  onTasksChanged,
}: {
  /** 侧栏/新建入口带进来的任务(至少含 id;详情异步补全) */
  task: CloudTask;
  mcHost: string;
  /** 状态变化(停止/结束)后让 App 刷新侧栏列表;关闭视图走 App 的 Esc/侧栏切换 */
  onTasksChanged?: () => void;
}) {
  const id = task.id;
  const [meta, setMeta] = useState<CloudTaskDetail | null>(null);
  const [chat, setChat] = useState<ChatState>(initialChat);
  const [status, setStatus] = useState("加载中…");
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState<{ cursor: string; hasMore: boolean } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [err, setErr] = useState("");

  // 历史帧(已完成轮次,时间正序)与当前轮实时帧分开存:实时增量归约,
  // 历史前插时整体重算(重算彼时只有几千帧,代价可忽略)。
  // 不变式:liveRef 只保存"当前未结束轮"的帧——轮一结束就归档进 historyRef,
  // 这样(重)建 attach 连接时清空 liveRef 再由服务端整轮回放,天然不重复。
  const historyRef = useRef<Frame[]>([]);
  const liveRef = useRef<Frame[]>([]);
  const connRef = useRef<CloudConn | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  // 回调经 ref 转接:父组件每次渲染的内联箭头不能进 WS effect 依赖,
  // 否则每次重渲染都重建连接(服务端会把当前轮整轮重放一遍 → 内容重复)
  const onTasksChangedRef = useRef(onTasksChanged);
  onTasksChangedRef.current = onTasksChanged;

  // ===== 发送排队:发消息与连接生命周期解耦 =====
  // 任何时刻都能按发送:环境启动中/正在执行/流还没同步上/上一条还没回执时
  // 先入队,就绪(轮结束、attach 同步完)后自动投递;连发多条合并进同一队列,
  // 不会再出现"第二条把第一条的连接关掉导致丢消息"。
  const [queued, setQueuedState] = useState("");
  const queuedRef = useRef("");
  const setQueued = useCallback((v: string) => {
    queuedRef.current = v;
    setQueuedState(v);
  }, []);
  const runningRef = useRef(false); // chat.running 镜像(稳定回调里读)
  const sendingRef = useRef(false); // 直发后等首帧回执,期间再发只入队
  const trySendRef = useRef<() => void>(() => {}); // 解循环依赖:投递入口经 ref 调用

  const taskStatus = meta?.status ?? task.status ?? "pending";
  const ended = taskStatus === "finished" || taskStatus === "error";
  const statusRef = useRef(taskStatus);
  statusRef.current = taskStatus;
  // VM 状态:云环境空闲会休眠(hibernated);休眠期间发送入队,唤醒后自动投递
  const vmId = meta?.virtualmachine?.id ?? "";
  const vmStatus = meta?.virtualmachine?.status ?? "";
  const hibernatedRef = useRef(false);
  hibernatedRef.current = taskStatus === "processing" && vmStatus === "hibernated";
  const label = task.title || task.summary || task.content || meta?.title || meta?.summary || "云端任务";

  const rebuild = useCallback(() => {
    setChat(reduceBatch(initialChat, [...historyRef.current, ...liveRef.current]));
  }, []);

  // attach 生命周期与轮询解耦:vmStatus 抖动不能反复拆建连接——每次重建
  // 都会把 connectCloudTask 内部的重连上限(dialFails/dropCount)清零,
  // 3s/10s 的轮询节奏快于内部 ~30s 的放弃阈值,表现为永久"断开重连"。
  // 休眠期间不发起(effect 内读 ref);唤醒完成经 attachEpoch 触发一次重建。
  const [attachEpoch, setAttachEpoch] = useState(0);
  // attach 已收束/放弃(onIdle):不再自动重建;发消息(mode=new)或唤醒重新武装
  const attachIdleRef = useRef(false);
  const sendFailsRef = useRef(0); // 连续投递失败计数(超限暂停自动重试)

  const refreshInfo = useCallback(async () => {
    try {
      const info = await mcTaskInfo(id);
      setMeta(info);
      // VM 唤醒完成:休眠期间压着的排队消息可以投递了;attach 也重新武装
      // (唤醒 = 新的活动窗口,给一次重建机会——按转变触发,不随轮询抖)
      if (info.virtualmachine?.status === "online" && hibernatedRef.current) {
        hibernatedRef.current = false;
        attachIdleRef.current = false;
        sendFailsRef.current = 0;
        setAttachEpoch((e) => e + 1);
        setTimeout(() => trySendRef.current(), 100);
      }
      return info;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [id]);

  // 进入/切任务:复位 + 拉详情;结束态任务直接回放最近一轮;
  // 运行中任务也从 REST 播种历史(见下)
  useEffect(() => {
    historyRef.current = [];
    liveRef.current = [];
    setChat(initialChat);
    setCursor(null);
    setErr("");
    setInput("");
    pinnedRef.current = true;
    attachIdleRef.current = false;
    sendFailsRef.current = 0;
    let alive = true;
    void (async () => {
      const info = await refreshInfo();
      if (!alive || !info) return;
      if (info.status === "finished" || info.status === "error") {
        try {
          const r = await mcTaskRounds(id, "", 1);
          if (!alive) return;
          historyRef.current = r.frames ?? [];
          setCursor(r.next_cursor ? { cursor: r.next_cursor, hasMore: !!r.has_more } : null);
          rebuild();
          setStatus("已结束,只读回放");
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      } else if (info.status === "processing") {
        // processing 此前完全依赖 attach 回放当前轮:attach 空闲关闭/失败时
        // 对话区全空,且收不到 cursor 帧,"加载更早"也永不可达。这里从 REST
        // 播种已完成轮 + 翻页游标兜底;活跃轮的尾巴丢弃(最后一个 task-ended
        // 之后的帧),当前轮以 attach 整轮回放为权威,避免与回放重复
        try {
          const r = await mcTaskRounds(id, "", 2);
          if (!alive) return;
          const frames = r.frames ?? [];
          const lastEnd = frames.map((f) => f.type).lastIndexOf("task-ended");
          historyRef.current = frames.slice(0, lastEnd + 1);
          setCursor(r.next_cursor ? { cursor: r.next_cursor, hasMore: !!r.has_more } : null);
          if (historyRef.current.length) rebuild();
        } catch {
          // 播种失败不致命:attach 回放仍在,保持原行为
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, refreshInfo, rebuild]);

  // 状态轮询:pending/休眠唤醒中 3s(盯状态翻转),processing 10s(刷新元数据)
  const vmWaking = taskStatus === "processing" && vmStatus === "hibernated";
  useEffect(() => {
    if (ended) return;
    const fast = taskStatus === "pending" || vmWaking;
    const t = setInterval(() => void refreshInfo(), fast ? 3000 : 10000);
    return () => clearInterval(t);
  }, [taskStatus, ended, vmWaking, refreshInfo]);

  // 常驻控制流:进对话即连——服务端在控制连接建立时会自动唤醒休眠 VM,
  // 且连接存续期间持续保活(不休眠);关闭视图断开,云端开始空闲倒计时。
  // 与 web 控制台行为一致;switch_model/端口列表也复用这条连接。
  const ctrlRef = useRef<ReturnType<typeof connectCloudControl> | null>(null);
  useEffect(() => {
    if (ended || !vmId) return;
    const ctrl = connectCloudControl(id);
    ctrlRef.current = ctrl;
    // 连接触发唤醒后,尽快让轮询看到状态翻转
    const t = setTimeout(() => void refreshInfo(), 1500);
    return () => {
      clearTimeout(t);
      ctrl.close();
      ctrlRef.current = null;
    };
  }, [id, ended, vmId, refreshInfo]);

  // 帧下发处理:cursor 帧捕获翻页游标,其余喂归约;轮结束把当前轮归档进历史
  const onFrames = useCallback(
    (batch: Frame[]) => {
      const frames: Frame[] = [];
      let turnEnded = false;
      for (const f of batch) {
        if (f.type === "cursor") {
          const c = parseCursor(f);
          if (c?.cursor) setCursor((prev) => prev ?? { cursor: c.cursor!, hasMore: !!c.has_more });
          continue;
        }
        if (f.type === "task-started") runningRef.current = true;
        if (f.type === "task-ended") turnEnded = true;
        frames.push(f);
      }
      if (!frames.length) return;
      sendingRef.current = false; // 收到帧 = 上一条直发已被云端接收
      sendFailsRef.current = 0; // 通路恢复,投递失败计数归零
      liveRef.current.push(...frames);
      setChat((s) => reduceBatch(s, frames));
      if (turnEnded) {
        historyRef.current = [...historyRef.current, ...liveRef.current];
        liveRef.current = [];
        runningRef.current = false;
        // 轮结束是排队消息的主要投递时机(稍等连接收尾)
        setTimeout(() => trySendRef.current(), 200);
      }
    },
    [],
  );

  const connHandlers = useCallback(
    () => ({
      onFrames,
      onStatus: (text: string, ok: boolean) => {
        setStatus(text);
        setConnected(ok);
        if (ok) {
          // 连上后稍等回放揭示轮状态,再尝试投递排队消息
          setTimeout(() => trySendRef.current(), 400);
        }
      },
      onEnded: () => void refreshInfo().then(() => onTasksChangedRef.current?.()),
      // 空闲关闭(云端对"当前轮已结束"的 attach 直接关连接):不是断线,
      // 转就绪态——可直接发消息(届时另建 mode=new 连接)。
      // 收束即撤下自动重建武装并清掉死连接引用:引用不清,attach effect 的
      // connRef 守卫会永远挡住唤醒后的重建
      onIdle: () => {
        attachIdleRef.current = true;
        connRef.current = null;
        runningRef.current = false;
        setConnected(false);
        setStatus("已就绪,可继续对话");
        setTimeout(() => trySendRef.current(), 100);
      },
      // 首条输入未送达(拨号失败/零回显被关):放回队列头,绝不静默丢。
      // 该连接已死,引用一并清掉;连续失败超限后暂停自动重试(内容仍在
      // 队列),否则"投递→被拒→2s 再投"会自持死循环
      onSendFailed: (text: string) => {
        sendingRef.current = false;
        connRef.current = null;
        setQueued(queuedRef.current ? text + "\n" + queuedRef.current : text);
        sendFailsRef.current += 1;
        // 重建 attach 拿回观察通道:被拒大多因为轮在跑/环境未就绪,
        // attach 回放能揭示真实轮状态(收到帧会把失败计数归零),
        // 轮结束后排队消息自动投递
        setAttachEpoch((e) => e + 1);
        if (sendFailsRef.current < 3) {
          setStatus("消息未送达,已重新排队");
          setTimeout(() => trySendRef.current(), 2000);
        } else {
          setStatus("⚠ 消息多次未送达,已暂停自动重试;等环境就绪或点发送再试");
        }
      },
      // 断线重连(降级 attach)会整轮回放当前轮:清本地当前轮缓存,回放为权威
      onReconnect: () => {
        liveRef.current = [];
        setChat(reduceBatch(initialChat, historyRef.current));
      },
    }),
    [onFrames, refreshInfo, setQueued],
  );

  // 运行中:WS attach 跟看(内核代理带 monkeycode 会话拨云端)。
  // 依赖刻意不含 vmWaking:vmStatus 由轮询刷新,抖动会反复拆建连接,
  // 每次重建把 connectCloudTask 内部的重连上限清零 → 永久"断开重连"。
  // 休眠与否在 effect 内读 ref;唤醒完成由 refreshInfo 按转变 bump
  // attachEpoch 触发一次重建。
  useEffect(() => {
    if (taskStatus !== "processing") return;
    // VM 休眠/唤醒中不发起 attach(必被拒,徒增重连噪音)
    if (hibernatedRef.current) return;
    // attach 已收束/放弃:不自动重建(发消息走 mode=new;唤醒经 epoch 重新武装)
    if (attachIdleRef.current) return;
    if (connRef.current) return; // 发消息时已切换为 mode=new 连接,不重复建
    // attach 会整轮回放当前轮:清掉本地当前轮缓存,以服务端回放为权威
    liveRef.current = [];
    setChat(reduceBatch(initialChat, historyRef.current));
    connRef.current = connectCloudTask(id, "attach", connHandlers());
    return () => {
      connRef.current?.close();
      connRef.current = null;
    };
  }, [id, taskStatus, attachEpoch, connHandlers]);

  // 贴底跟随(简化版:仅程序滚动,不做锚点恢复——云端流为跟看场景)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const loadEarlier = async () => {
    if (!cursor || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const r = await mcTaskRounds(id, cursor.cursor, 1);
      historyRef.current = [...(r.frames ?? []), ...historyRef.current];
      setCursor(r.next_cursor && r.has_more !== false ? { cursor: r.next_cursor, hasMore: !!r.has_more } : null);
      pinnedRef.current = false;
      rebuild();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingEarlier(false);
    }
  };

  // 直发:并入历史 → 换 mode=new 连接(连上自动上行 user-input,云端回显)。
  // 只在"任务空闲且流已同步"时走这条路;其余场景一律入队(见 sendMsg)。
  const dispatch = useCallback(
    (text: string) => {
      historyRef.current = [...historyRef.current, ...liveRef.current];
      liveRef.current = [];
      connRef.current?.close();
      pinnedRef.current = true;
      sendingRef.current = true;
      // 回执保护:15s 没等到任何帧(投递失败/被拒)就解除,让排队恢复流动
      setTimeout(() => {
        if (sendingRef.current) {
          sendingRef.current = false;
          trySendRef.current();
        }
      }, 15000);
      connRef.current = connectCloudTask(id, "new", connHandlers(), text);
    },
    [id, connHandlers],
  );

  // 投递排队消息(对齐 mobile handleSend:直接建 mode=new 连接上行,服务端
  // 才是运行互斥/休眠唤醒的权威,被拒会 onSendFailed 回队重试)。此前还要求
  // attach 已同步(syncedRef)、VM 非休眠(hibernatedRef)、任务 processing:
  // 三者全是本地推断,attach 连不上 / 详情接口 VM 状态不同步时永远为假,
  // 消息卡在"已排队"死等——发送与 attach 生命周期必须彻底解耦
  const trySendQueued = useCallback(() => {
    if (!queuedRef.current) return;
    if (statusRef.current === "finished" || statusRef.current === "error") return;
    if (runningRef.current || sendingRef.current) return; // 可见在跑/未回执才等
    if (sendFailsRef.current >= 3) return; // 连败暂停:收到帧/唤醒/手动发送解除
    const q = queuedRef.current;
    setQueued("");
    dispatch(q);
  }, [dispatch, setQueued]);
  trySendRef.current = trySendQueued;

  // 发送:随时可按。本轮可见在跑/上一条未回执 → 入队(多条合并,轮结束自动
  // 投递);其余一律直发,交服务端裁决
  const sendMsg = () => {
    const text = input.trim();
    if (!text || ended) return;
    setInput("");
    sendFailsRef.current = 0; // 手动发送 = 用户明确要投递,重试机会重置
    // 上一条直发还没回执:合并入队,别把在途连接顶掉
    if (sendingRef.current) {
      setQueued(queuedRef.current ? queuedRef.current + "\n" + text : text);
      return;
    }
    // 手动发送不看本地 running 推断:被打断的轮(VM 休眠等)回放里只有
    // task-started 没有 task-ended,runningRef 永远卡 true,消息全进队列
    // 死等。轮是否真在跑由服务端裁决——真在跑 mode=new 会被拒,走
    // onSendFailed 回队;已死的轮则直接开新轮。队列里压着的一并带上
    const full = [queuedRef.current, text].filter(Boolean).join("\n");
    setQueued("");
    dispatch(full);
  };

  // 任务结束时还压着排队消息:外显提醒,不静默丢
  useEffect(() => {
    if (ended && queuedRef.current) {
      setErr(`任务已结束,有未发送的消息:「${queuedRef.current.slice(0, 60)}」`);
      setQueued("");
    }
  }, [ended, setQueued]);

  // 中断当前执行(WS user-cancel,不终止任务)
  const cancelRun = () => {
    connRef.current?.send("user-cancel");
  };

  // 终止任务(REST stop);确认放在 ⋯ 菜单里(与 ChatView 删除会话的交互一致)
  const [menu, setMenu] = useState<"closed" | "open" | "confirm">("closed");
  const stopTask = async () => {
    setMenu("closed");
    try {
      await mcTaskStop(id);
      await refreshInfo();
      onTasksChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  // 输入框随内容自适应高度(与 ChatView 一致)
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  // 文件抽屉 / 终端面板(控制流与终端 WS 均走内核代理)
  const [filesOpen, setFilesOpen] = useState(false);
  const [termOpen, setTermOpen] = useState(false);

  // 回答 AI 提问:reply-question 经任务流上行(request_id 即 askId),乐观回写 UI
  const onAskAnswer = useCallback((askId: string, answers: Record<string, string | string[]>) => {
    const sent = connRef.current?.send("reply-question", {
      request_id: askId,
      answers_json: JSON.stringify(answers),
      cancelled: false,
    });
    if (sent) setChat((s) => answerAsk(s, askId, answers));
    else setErr("云端连接已断开,回答未发送;等重连后再试");
  }, []);

  // 切换模型:一次性控制流连接调 switch_model(load_session 保留会话上下文)
  const [cloudModels, setCloudModels] = useState<McCloudModel[] | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const openModelPicker = () => {
    setModelOpen((o) => !o);
    if (!cloudModels) {
      mcTaskOptions()
        .then((o) => setCloudModels(usableCloudModels(o.models, o.plan)))
        .catch(() => setCloudModels([]));
    }
  };
  const switchModel = async (modelId: string) => {
    setModelOpen(false);
    if (switching || modelId === meta?.model?.id) return;
    setSwitching(true);
    setErr("");
    // 优先复用常驻控制连接;不在(结束态等)才临时建一条
    const shared = ctrlRef.current;
    const ctrl = shared ?? connectCloudControl(id);
    try {
      await ctrl.call("switch_model", { model_id: modelId, load_session: true });
      await refreshInfo();
    } catch (e) {
      setErr("切换模型失败: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      if (!shared) ctrl.close();
      setSwitching(false);
    }
  };

  // 在线预览:⋯ 菜单打开时拉端口列表,access_url 可直接在浏览器打开
  interface PortInfo {
    port?: number;
    access_url?: string;
    label?: string;
    process?: string;
    status?: string;
  }
  const [ports, setPorts] = useState<PortInfo[] | null>(null);
  const fetchPorts = () => {
    if (!vmId || ended) return;
    setPorts(null);
    const shared = ctrlRef.current;
    const ctrl = shared ?? connectCloudControl(id);
    ctrl
      .call<{ ports?: PortInfo[] }>("port_forward_list")
      .then((r) => setPorts(r.ports ?? []))
      .catch(() => setPorts([]))
      .finally(() => {
        if (!shared) ctrl.close();
      });
  };

  const st = STATUS_LABEL[taskStatus] ?? { text: taskStatus, color: "var(--t4)" };
  const running = chat.running && taskStatus === "processing";
  const roundNo = Math.max(1, chat.items.filter((it) => it.kind === "user").length);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, position: "relative" }}>
      {/* ==== 标题栏:几何与 ChatView 一致(56px 双行,空白区可拖拽窗口)==== */}
      <div data-tauri-drag-region="" style={{ height: 56, flex: "none", display: "flex", alignItems: "center", gap: 12, padding: "0 24px", borderBottom: "1px solid var(--line2)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span className="ellipsis" title={label} style={{ fontWeight: 700, fontSize: 13.5 }}>
            {label}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--t5)", minWidth: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: st.color === "var(--t4)" ? "var(--t6)" : st.color, flex: "none" }} />
            <span style={{ fontWeight: 600, color: st.color, flex: "none" }}>{st.text}</span>
            {/* 云环境休眠/唤醒外显:打开对话即触发唤醒(常驻控制连接),这里给可见反馈 */}
            {vmWaking && (
              <>
                <span style={{ color: "var(--t7)", flex: "none" }}>·</span>
                <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5, borderColor: "var(--warn)", borderTopColor: "transparent" }} />
                <span style={{ fontWeight: 600, color: "var(--warn)", flex: "none" }}>环境唤醒中</span>
              </>
            )}
            {taskStatus === "processing" && vmStatus === "offline" && (
              <>
                <span style={{ color: "var(--t7)", flex: "none" }}>·</span>
                <span style={{ fontWeight: 600, color: "var(--t5)", flex: "none" }}>环境离线</span>
              </>
            )}
            <span style={{ color: "var(--t7)", flex: "none" }}>·</span>
            <IconCloud size={11} color="var(--t6)" />
            <span style={{ flex: "none" }}>云端</span>
            {meta?.model && (
              <>
                <span style={{ color: "var(--t7)", flex: "none" }}>·</span>
                <span className="ellipsis">{cloudModelLabel(meta.model)}</span>
              </>
            )}
          </span>
        </div>
        <span data-tauri-drag-region="" style={{ flex: 1, alignSelf: "stretch" }} />
        {/* 头部只留两个控件(与本地会话一致):文件 + ⋯;终端/网页/预览/终止收进菜单 */}
        <button
          className="hv"
          title="浏览云端工作区文件(标注改动)"
          onClick={() => setFilesOpen(true)}
          style={{
            height: 28,
            border: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 12px",
            borderRadius: 8,
            background: "var(--card)",
            fontSize: 12,
            color: "var(--t2)",
            cursor: "pointer",
            fontWeight: 600,
            boxShadow: "var(--cardSh)",
            flex: "none",
          }}
        >
          <IconFolder size={12} />
          文件
        </button>
        <div style={{ position: "relative", flex: "none" }}>
          <button
            className="hv icon-btn"
            title="更多"
            onClick={() => {
              const next = menu === "closed" ? "open" : "closed";
              setMenu(next);
              if (next === "open") fetchPorts();
            }}
            style={{ width: 28, height: 28, borderRadius: 8, background: menu !== "closed" ? "var(--hov)" : "transparent" }}
          >
            <IconDots size={14} color="var(--t5)" />
          </button>
          {menu !== "closed" && (
            <>
              <div className="backdrop" onClick={() => setMenu("closed")} />
              <div className="pop" style={{ position: "absolute", top: 32, right: 0, minWidth: 180 }}>
                {menu === "open" ? (
                  <>
                    {vmId && !ended && (
                      <button
                        className="hv menu-item"
                        onClick={() => {
                          setMenu("closed");
                          setTermOpen((o) => !o);
                        }}
                        style={{ gap: 8 }}
                      >
                        <IconMonitor size={13} strokeWidth={1.4} color="var(--t3)" />
                        <span style={{ flex: 1 }}>{termOpen ? "关闭终端" : "打开终端"}</span>
                      </button>
                    )}
                    <button
                      className="hv menu-item"
                      title="完整控制台:预览/共享终端/文件下载等"
                      onClick={() => {
                        setMenu("closed");
                        openExternal(`https://${mcHost}/console/task/${id}`);
                      }}
                      style={{ gap: 8 }}
                    >
                      <IconGlobe size={13} color="var(--t3)" />
                      <span style={{ flex: 1 }}>在浏览器打开</span>
                    </button>
                    {!ended && vmId && (
                      <>
                        <span style={{ height: 1, background: "var(--line2)", margin: "4px 6px" }} />
                        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--t6)", padding: "5px 9px 3px" }}>
                          在线预览
                        </span>
                        {ports === null && (
                          <div style={{ padding: "3px 9px 6px", fontSize: 11.5, color: "var(--t5)" }}>检测开放端口…</div>
                        )}
                        {ports !== null && ports.filter((p) => p.access_url).length === 0 && (
                          <div style={{ padding: "3px 9px 6px", fontSize: 11.5, color: "var(--t5)" }}>没有开放的端口</div>
                        )}
                        {(ports ?? [])
                          .filter((p) => p.access_url)
                          .map((p) => (
                            <button
                              key={p.port}
                              className="hv menu-item"
                              title={p.access_url}
                              onClick={() => {
                                setMenu("closed");
                                openExternal(p.access_url!);
                              }}
                              style={{ gap: 8 }}
                            >
                              <IconGlobe size={12} color="var(--acc)" />
                              <span style={{ flex: 1, minWidth: 0 }} className="ellipsis">
                                :{p.port} {p.label || p.process || ""}
                              </span>
                            </button>
                          ))}
                      </>
                    )}
                    {!ended && (
                      <>
                        <span style={{ height: 1, background: "var(--line2)", margin: "4px 6px" }} />
                        <button className="hv-errbg menu-item" style={{ color: "var(--err)" }} onClick={() => setMenu("confirm")}>
                          <IconStop color="var(--err)" />
                          终止任务
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ padding: "6px 9px 4px", fontSize: 11.5, color: "var(--t4)", lineHeight: 1.6, maxWidth: 200, whiteSpace: "normal" }}>
                      终止后云端虚拟机将回收,任务不可继续。
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        className="hv-errbg menu-item"
                        style={{ color: "var(--err)", fontWeight: 600 }}
                        onClick={() => void stopTask()}
                      >
                        确认终止
                      </button>
                      <button className="hv menu-item" onClick={() => setMenu("closed")}>
                        取消
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ==== 对话流:列宽/内距/滚动条预留与 ChatView 一致 ==== */}
      <div
        ref={scrollRef}
        onWheel={(e) => {
          if (e.deltaY < 0) pinnedRef.current = false;
        }}
        onScroll={() => {
          const el = scrollRef.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 40) pinnedRef.current = true;
        }}
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0, scrollbarGutter: "stable both-edges" }}
      >
        <div style={{ maxWidth: COL_MAX, margin: "0 auto", padding: "26px 36px 16px", display: "flex", flexDirection: "column", gap: 18 }}>
          {cursor && (
            <button
              className="hv"
              onClick={() => void loadEarlier()}
              style={{ alignSelf: "center", border: "1px solid var(--line)", background: "var(--card)", color: "var(--t3)", fontSize: 11.5, borderRadius: 8, padding: "4px 14px", cursor: "pointer", boxShadow: "var(--cardSh)" }}
            >
              {loadingEarlier ? "加载中…" : "加载更早的对话"}
            </button>
          )}
          {taskStatus === "pending" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 13px", borderRadius: 9, background: "var(--warnBg)", border: "1px solid var(--warnBd2)", fontSize: 12.5, color: "var(--warnT)" }}>
              <span className="spinner" style={{ width: 12, height: 12, borderColor: "var(--warn)", borderTopColor: "transparent" }} />
              {vmCondition(meta)}
            </div>
          )}
          {chat.items.length === 0 && taskStatus !== "pending" && (
            <div style={{ padding: "40px 0", textAlign: "center", fontSize: 12.5, color: "var(--t5)" }}>
              {ended ? "没有可回放的对话记录。" : status}
            </div>
          )}
          <LogList items={chat.items} onPermAnswer={() => {}} onAskAnswer={ended ? undefined : onAskAnswer} />
        </div>
      </div>

      {/* ==== 运行条 + 终端卡 + composer:与 ChatView 同列宽同出血 ==== */}
      <div style={{ flex: "none", maxWidth: COL_MAX, width: "calc(100% - 16px)", margin: "0 auto", padding: "0 36px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
        {/* 实时任务面板(与本地会话同款,钉住不进流) */}
        {chat.plan.length > 0 && <TaskPanel entries={chat.plan} />}
        {/* 终端:对话列同宽的圆角深色悬浮卡(与 composer 同出血),融入卡片语言 */}
        {termOpen && vmId && !ended && (
          <div
            style={{
              height: 280,
              margin: "0 -12px",
              borderRadius: 12,
              overflow: "hidden",
              border: "1px solid var(--line)",
              boxShadow: "var(--panelShLg)",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              background: "#1c1e22",
              animation: "mcin .2s ease",
            }}
          >
            <div style={{ flex: "none", height: 32, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", background: "#24272c", borderBottom: "1px solid #2e3238" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--ok)", flex: "none" }} />
              <span style={{ color: "#c3cad3", fontSize: 11.5, fontWeight: 600 }}>云端终端</span>
              <span style={{ color: "#6d7580", fontSize: 11 }}>任务虚拟机 · /workspace</span>
              <span style={{ flex: 1 }} />
              <button className="icon-btn" title="关闭终端" onClick={() => setTermOpen(false)} style={{ width: 22, height: 22, borderRadius: 6 }}>
                <IconX size={10} color="#8b93a0" />
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <CloudTerminal vmId={vmId} />
            </div>
          </div>
        )}
        {err && <div style={{ fontSize: 12, color: "var(--err)" }}>{err}</div>}
        {running && (
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span className="spinner" />
            <span style={{ fontWeight: 600, fontSize: 12.5 }}>云端执行中</span>
            <span style={{ fontSize: 12, color: "var(--t5)" }}>第 {roundNo} 轮</span>
            <span style={{ flex: 1 }} />
            <button
              className="hv-errbg"
              title="中断当前执行(任务保留,可继续对话)"
              onClick={cancelRun}
              style={{
                height: 26,
                border: "1px solid var(--errBd)",
                background: "transparent",
                color: "var(--err)",
                borderRadius: 13,
                padding: "0 12px",
                fontSize: 11.5,
                fontWeight: 600,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <IconStop />
              停止
            </button>
          </div>
        )}

        {queued && !ended && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--panel2)",
              border: "1px solid var(--cardBd)",
              borderRadius: 10,
              padding: "7px 12px",
              fontSize: 12,
              margin: "0 -12px",
            }}
          >
            <IconClock />
            <span style={{ color: "var(--t3)", flex: "none" }}>已排队</span>
            <span className="ellipsis" style={{ fontWeight: 600, flex: 1 }}>{queued}</span>
            <span style={{ color: "var(--t6)", flex: "none", fontSize: 11.5 }}>
              {taskStatus === "pending" ? "环境就绪后自动发送" : vmWaking ? "环境唤醒后自动发送" : "本轮结束后自动发送"}
            </span>
            <button className="hv2 icon-btn" title="取消排队" onClick={() => setQueued("")} style={{ width: 20, height: 20, borderRadius: 5 }}>
              <IconX />
            </button>
          </div>
        )}

        {ended ? (
          <div style={{ fontSize: 12, color: "var(--t5)", textAlign: "center", padding: "4px 0" }}>
            任务已结束,只读回放。需要继续可新建云端任务。
          </div>
        ) : (
          <div
            style={{
              background: "var(--panel)",
              border: "1px solid var(--inputBd)",
              borderRadius: 12,
              boxShadow: "var(--panelSh)",
              display: "flex",
              flexDirection: "column",
              margin: "0 -12px", // 光学对齐出血,与 ChatView composer 一致
            }}
          >
            <textarea
              ref={taRef}
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onCompositionEnd={markImeEnd}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !isImeEnter(e)) {
                  e.preventDefault();
                  sendMsg();
                }
              }}
              placeholder={
                taskStatus === "pending"
                  ? "环境启动中…现在发送会排队,就绪后自动送达"
                  : vmWaking
                    ? "环境唤醒中…现在发送会排队,唤醒后自动送达"
                    : running
                      ? "补充说明…运行中发送会排队"
                      : "继续对话…"
              }
              style={{
                border: "none",
                outline: "none",
                resize: "none",
                background: "transparent",
                color: "var(--t1)",
                padding: "12px 15px 2px",
                fontSize: 13,
                lineHeight: 1.5,
                maxHeight: 160,
                display: "block",
                width: "100%",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px 10px" }}>
              <span
                title={`${status} · 任务运行在云端服务器,关掉客户端也会继续`}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--t5)", minWidth: 0 }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: connected ? "var(--ok)" : "var(--t6)", flex: "none" }} />
                <span className="ellipsis">{status}</span>
              </span>
              <span style={{ flex: 1 }} />
              {/* 云端模型切换(经控制流 switch_model,保留会话上下文;执行中禁用) */}
              <span style={{ position: "relative", flex: "none" }}>
                <button
                  className="hv"
                  title={running ? "执行中不可切换模型" : "切换云端模型"}
                  disabled={running || switching}
                  onClick={openModelPicker}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    height: 24,
                    padding: "0 8px",
                    border: "none",
                    borderRadius: 7,
                    background: modelOpen ? "var(--hov)" : "transparent",
                    cursor: running || switching ? "default" : "pointer",
                    fontSize: 11.5,
                    color: "var(--t3)",
                    maxWidth: 200,
                    opacity: running || switching ? 0.5 : 1,
                  }}
                >
                  <span className="ellipsis">{switching ? "切换中…" : cloudModelLabel(meta?.model) || "模型"}</span>
                  <IconChevronDown color="var(--t5)" />
                </button>
                {modelOpen && (
                  <>
                    <div className="backdrop" onClick={() => setModelOpen(false)} />
                    <div className="pop" style={{ position: "absolute", bottom: 30, right: 0, borderRadius: 10, minWidth: 210, maxHeight: 280, overflowY: "auto" }}>
                      {(cloudModels ?? []).map((m) => (
                        <button key={m.id} className="hv menu-item" onClick={() => void switchModel(m.id!)} style={{ gap: 8 }}>
                          <span className="ellipsis" style={{ flex: 1, fontSize: 12.5, color: "var(--t2)" }}>{cloudModelLabel(m)}</span>
                          {m.id === meta?.model?.id && <IconCheck size={11} color="var(--acc)" strokeWidth={1.6} />}
                        </button>
                      ))}
                      {cloudModels === null && (
                        <span style={{ fontSize: 11.5, color: "var(--t6)", padding: "6px 9px" }}>加载中…</span>
                      )}
                      {cloudModels !== null && cloudModels.length === 0 && (
                        <span style={{ fontSize: 11.5, color: "var(--t6)", padding: "6px 9px" }}>没有可用模型</span>
                      )}
                    </div>
                  </>
                )}
              </span>
              <button
                className="hv-acc icon-btn"
                title="发送 ↩ · 换行 ⇧↩"
                onClick={sendMsg}
                style={{
                  width: 27,
                  height: 27,
                  borderRadius: 8,
                  background: "var(--acc)",
                  opacity: input.trim() ? 1 : 0.45,
                }}
              >
                <IconSend />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ==== 云端文件抽屉(右侧浮层,结构对齐本地文件抽屉)==== */}
      {filesOpen && (
        <>
          <div onClick={() => setFilesOpen(false)} style={{ position: "absolute", inset: 0, background: "var(--scrim)", zIndex: 35 }} />
          <div
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              width: 600,
              maxWidth: "90vw",
              background: "var(--pop)",
              borderLeft: "1px solid var(--line)",
              boxShadow: "var(--shadow)",
              zIndex: 36,
              display: "flex",
              flexDirection: "column",
              animation: "mcslide .22s ease",
            }}
          >
            <CloudFilesDrawer taskId={id} onClose={() => setFilesOpen(false)} />
          </div>
        </>
      )}
    </div>
  );
}
