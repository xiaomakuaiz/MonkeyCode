// 云端任务详情视图:在桌面内回放/跟看/操作 monkeycode 云端任务,不开浏览器。
// 数据流对齐移动端 task/[id].tsx:
//   结束态(finished/error) → REST rounds 只读回放,"加载更早"按 cursor 往前翻;
//   启动中(pending)        → 轮询详情展示 VM 准备进度,转 processing 后接流;
//   运行中(processing)     → WS attach(内核代理)回放当前轮 + 实时;发消息切 mode=new。
// 渲染复用本地会话的帧归约链(reduceBatch → LogList):云端帧与本地 Frame 同构。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectCloudTask,
  mcTaskInfo,
  mcTaskRounds,
  mcTaskStop,
  openExternal,
  type CloudConn,
  type CloudTask,
  type CloudTaskDetail,
} from "./client";
import { cloudModelLabel } from "./cloud";
import { b64decode } from "./codec";
import { isImeEnter, markImeEnd } from "./chat";
import { LogList } from "./components";
import { IconCloud, IconSend, IconX } from "./icons";
import { initialChat, reduceBatch, type ChatState } from "./reduce";
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
  onClose,
  onTasksChanged,
}: {
  /** 侧栏/新建入口带进来的任务(至少含 id;详情异步补全) */
  task: CloudTask;
  mcHost: string;
  onClose: () => void;
  /** 状态变化(停止/结束)后让 App 刷新侧栏列表 */
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

  const taskStatus = meta?.status ?? task.status ?? "pending";
  const ended = taskStatus === "finished" || taskStatus === "error";
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
    [],
  );

  const connHandlers = useCallback(
    () => ({
      onFrames,
      onStatus: (text: string, ok: boolean) => {
        setStatus(text);
        setConnected(ok);
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

  // 发后续消息:并入历史(兜底,轮结束时通常已归档)→ 换 mode=new 连接
  // (连上自动上行 user-input,云端回显,无需本地插气泡)
  const sendMsg = () => {
    const text = input.trim();
    if (!text || ended) return;
    historyRef.current = [...historyRef.current, ...liveRef.current];
    liveRef.current = [];
    connRef.current?.close();
    pinnedRef.current = true;
    connRef.current = connectCloudTask(id, "new", connHandlers(), text);
    setInput("");
  };

  // 中断当前执行(WS user-cancel,不终止任务)
  const cancelRun = () => {
    connRef.current?.send("user-cancel");
  };

  // 终止任务(REST stop);确认一次
  const [confirmStop, setConfirmStop] = useState(false);
  const stopTask = async () => {
    setConfirmStop(false);
    try {
      await mcTaskStop(id);
      await refreshInfo();
      onTasksChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const st = STATUS_LABEL[taskStatus] ?? { text: taskStatus, color: "var(--t4)" };
  const running = chat.running && taskStatus === "processing";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
      {/* 头部:标题 + 状态 + 模型 + 操作 */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 18px", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>
        <IconCloud size={14} color="var(--warn)" style={{ flex: "none" }} />
        <span className="ellipsis" title={label} style={{ fontSize: 13.5, fontWeight: 700, minWidth: 0 }}>
          {label}
        </span>
        <span style={{ flex: "none", fontSize: 11, fontWeight: 600, color: st.color }}>{st.text}</span>
        {meta?.model && (
          <span className="ellipsis" style={{ flex: "none", maxWidth: 180, fontSize: 11, color: "var(--t5)" }}>
            {cloudModelLabel(meta.model)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!ended && (
          confirmStop ? (
            <span style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
              <span style={{ fontSize: 11.5, color: "var(--t4)" }}>确认终止任务?</span>
              <button className="hv-errbg" onClick={() => void stopTask()} style={{ border: "none", background: "transparent", color: "var(--err)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: "3px 8px", borderRadius: 6 }}>
                终止
              </button>
              <button className="hv" onClick={() => setConfirmStop(false)} style={{ border: "none", background: "transparent", color: "var(--t3)", fontSize: 11.5, cursor: "pointer", padding: "3px 8px", borderRadius: 6 }}>
                取消
              </button>
            </span>
          ) : (
            <button
              className="hv"
              title="终止云端任务(虚拟机随之回收)"
              onClick={() => setConfirmStop(true)}
              style={{ flex: "none", border: "none", background: "transparent", color: "var(--err)", fontSize: 11.5, fontWeight: 600, cursor: "pointer", padding: "3px 9px", borderRadius: 6 }}
            >
              终止任务
            </button>
          )
        )}
        <button
          className="hv"
          title="在浏览器中打开(完整功能:文件/终端/预览)"
          onClick={() => openExternal(`https://${mcHost}/console/task/${id}`)}
          style={{ flex: "none", border: "none", background: "transparent", color: "var(--t4)", fontSize: 11.5, cursor: "pointer", padding: "3px 9px", borderRadius: 6 }}
        >
          网页打开
        </button>
        <button className="hv2 icon-btn" title="关闭 (esc)" onClick={onClose} style={{ flex: "none", width: 24, height: 24 }}>
          <IconX size={11} color="var(--t4)" />
        </button>
      </div>

      {/* 对话流 */}
      <div
        ref={scrollRef}
        onWheel={(e) => {
          if (e.deltaY < 0) pinnedRef.current = false;
        }}
        onScroll={() => {
          const el = scrollRef.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 40) pinnedRef.current = true;
        }}
        style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "14px 24px 20px" }}
      >
        <div style={{ maxWidth: 780, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14, lineHeight: 1.8 }}>
          {cursor && (
            <button
              className="hv"
              onClick={() => void loadEarlier()}
              style={{ alignSelf: "center", border: "1px solid var(--line)", background: "var(--card)", color: "var(--t3)", fontSize: 11.5, borderRadius: 8, padding: "4px 14px", cursor: "pointer" }}
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
          <LogList items={chat.items} onPermAnswer={() => {}} />
        </div>
      </div>

      {err && (
        <div style={{ padding: "6px 24px", fontSize: 12, color: "var(--err)", flex: "none" }}>{err}</div>
      )}

      {/* 底部:composer(运行中/排队中可发;结束态提示只读) */}
      <div style={{ flex: "none", padding: "10px 24px 14px", borderTop: "1px solid var(--line)" }}>
        <div style={{ maxWidth: 780, margin: "0 auto" }}>
          {ended ? (
            <div style={{ fontSize: 12, color: "var(--t5)", textAlign: "center", padding: "4px 0" }}>
              任务已结束,只读回放。需要继续可在网页端重新派发。
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, padding: "8px 10px" }}>
              <textarea
                value={input}
                rows={1}
                disabled={taskStatus === "pending"}
                onChange={(e) => setInput(e.target.value)}
                onCompositionEnd={markImeEnd}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !isImeEnter(e)) {
                    e.preventDefault();
                    sendMsg();
                  }
                }}
                placeholder={taskStatus === "pending" ? "云端环境启动中,就绪后可对话…" : "继续对话…(Enter 发送)"}
                style={{ flex: 1, border: "none", outline: "none", resize: "none", background: "transparent", color: "var(--t1)", fontSize: 13, lineHeight: 1.6, maxHeight: 120, minWidth: 0 }}
              />
              {running && (
                <button
                  className="hv"
                  title="中断当前执行(任务保留,可继续对话)"
                  onClick={cancelRun}
                  style={{ flex: "none", border: "1px solid var(--line)", background: "var(--card)", color: "var(--t3)", fontSize: 11.5, borderRadius: 8, padding: "5px 10px", cursor: "pointer" }}
                >
                  停止
                </button>
              )}
              <button
                className="hv-acc"
                title="发送"
                onClick={sendMsg}
                disabled={taskStatus === "pending" || !input.trim()}
                style={{
                  flex: "none",
                  width: 30,
                  height: 30,
                  border: "none",
                  borderRadius: 8,
                  background: "var(--acc)",
                  color: "var(--onAcc)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: taskStatus === "pending" || !input.trim() ? 0.45 : 1,
                }}
              >
                <IconSend size={12} />
              </button>
            </div>
          )}
          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: "var(--t5)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: connected ? "var(--ok)" : "var(--t6)", flex: "none" }} />
            <span className="ellipsis">{ended ? "任务已结束" : status} · 运行在云端服务器,关掉客户端也会继续</span>
          </div>
        </div>
      </div>
    </div>
  );
}
