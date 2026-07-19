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
import { LogList } from "./components";
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
  const syncedRef = useRef(false); // attach 至少连上过一次:running 状态才可信
  const sendingRef = useRef(false); // 直发后等首帧回执,期间再发只入队
  const trySendRef = useRef<() => void>(() => {}); // 解循环依赖:投递入口经 ref 调用

  const taskStatus = meta?.status ?? task.status ?? "pending";
  const ended = taskStatus === "finished" || taskStatus === "error";
  const statusRef = useRef(taskStatus);
  statusRef.current = taskStatus;
  const label = task.title || task.summary || task.content || meta?.title || meta?.summary || "云端任务";

  const rebuild = useCallback(() => {
    setChat(reduceBatch(initialChat, [...historyRef.current, ...liveRef.current]));
  }, []);

  const refreshInfo = useCallback(async () => {
    try {
      const info = await mcTaskInfo(id);
      setMeta(info);
      return info;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [id]);

  // 进入/切任务:复位 + 拉详情;结束态任务直接回放最近一轮
  useEffect(() => {
    historyRef.current = [];
    liveRef.current = [];
    setChat(initialChat);
    setCursor(null);
    setErr("");
    setInput("");
    pinnedRef.current = true;
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
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, refreshInfo, rebuild]);

  // 状态轮询:pending 3s(盯 VM 启动),processing 10s(刷新元数据/统计)
  useEffect(() => {
    if (ended) return;
    const t = setInterval(() => void refreshInfo(), taskStatus === "pending" ? 3000 : 10000);
    return () => clearInterval(t);
  }, [taskStatus, ended, refreshInfo]);

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
          syncedRef.current = true;
          // 连上后稍等回放揭示轮状态,再尝试投递排队消息
          setTimeout(() => trySendRef.current(), 400);
        }
      },
      onEnded: () => void refreshInfo().then(() => onTasksChangedRef.current?.()),
      // 断线重连(降级 attach)会整轮回放当前轮:清本地当前轮缓存,回放为权威
      onReconnect: () => {
        liveRef.current = [];
        setChat(reduceBatch(initialChat, historyRef.current));
      },
    }),
    [onFrames, refreshInfo],
  );

  // 运行中:WS attach 跟看(内核代理带 monkeycode 会话拨云端)。
  // 依赖全部稳定(id/taskStatus/稳定回调),只在进入 processing 时建一次。
  useEffect(() => {
    if (taskStatus !== "processing") return;
    if (connRef.current) return; // 发消息时已切换为 mode=new 连接,不重复建
    // attach 会整轮回放当前轮:清掉本地当前轮缓存,以服务端回放为权威
    liveRef.current = [];
    setChat(reduceBatch(initialChat, historyRef.current));
    connRef.current = connectCloudTask(id, "attach", connHandlers());
    return () => {
      connRef.current?.close();
      connRef.current = null;
    };
  }, [id, taskStatus, connHandlers]);

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

  // 投递排队消息:任务在跑/流未同步/上一条未回执时按兵不动,条件齐了再发
  const trySendQueued = useCallback(() => {
    if (!queuedRef.current) return;
    if (statusRef.current !== "processing") return;
    if (!syncedRef.current || runningRef.current || sendingRef.current) return;
    const q = queuedRef.current;
    setQueued("");
    dispatch(q);
  }, [dispatch, setQueued]);
  trySendRef.current = trySendQueued;

  // 发送:随时可按。空闲且已同步 → 直发;否则入队(多条合并),就绪自动投递
  const sendMsg = () => {
    const text = input.trim();
    if (!text || ended) return;
    setInput("");
    const idle =
      statusRef.current === "processing" && syncedRef.current && !runningRef.current && !sendingRef.current;
    if (idle) {
      dispatch(text);
    } else {
      setQueued(queuedRef.current ? queuedRef.current + "\n" + text : text);
    }
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
  const vmId = meta?.virtualmachine?.id ?? "";

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
    const ctrl = connectCloudControl(id);
    try {
      await ctrl.call("switch_model", { model_id: modelId, load_session: true });
      await refreshInfo();
    } catch (e) {
      setErr("切换模型失败: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      ctrl.close();
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
    const ctrl = connectCloudControl(id);
    ctrl
      .call<{ ports?: PortInfo[] }>("port_forward_list")
      .then((r) => setPorts(r.ports ?? []))
      .catch(() => setPorts([]))
      .finally(() => ctrl.close());
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
              {taskStatus === "pending" ? "环境就绪后自动发送" : "本轮结束后自动发送"}
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
