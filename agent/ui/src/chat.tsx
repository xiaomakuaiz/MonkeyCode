// 会话视图:标题栏 / 对话流 / 运行条 / 排队 chip / composer。
// 布局与数值取自设计稿 Chat 屏;协议交互(发送/审批/切模型等)统一走 session 句柄
// (useSession),App 只注入布局级回调(抽屉/子会话/归档/删除)。
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { LogList, MONO } from "./components";
import {
  IconArchive,
  IconChevronDown,
  IconClock,
  IconDots,
  IconFolder,
  IconSend,
  IconShield,
  IconStop,
  IconTrash,
  IconX,
} from "./icons";
import logoUrl from "./logo.png";
import type { SessionHandle } from "./useSession";
import { modelSourceLabel, type LogItem, type ModelInfo, type SessionMeta, type Usage } from "./types";

// 各会话的滚动位置记忆:切走再切回仍在原位;贴底离开的会话回来仍贴底。
// 记「视口顶部的条目序号 + 条目内偏移」而非 scrollTop 像素:历史分批回放、
// 工具结果合并进先前条目、折叠态重置都会改变上方内容高度,像素值会漂,
// 锚点跟着条目走才对得上"看到哪了"。切换时滚动容器随 chat 清空整个卸载重挂,
// 且 ChatView 本身也会因设置页等视图切换而重挂,记忆只能存在模块级
const scrollMemo = new Map<string, { anchor: number; offset: number; pinned: boolean }>();

const fmtK = (n: number) =>
  n >= 1_000_000 ? Math.round(n / 100_000) / 10 + "M" : n >= 1000 ? Math.round(n / 100) / 10 + "k" : String(n);

/** 对话/composer 共用列宽:680 起随窗口加宽,宽屏封顶 860(保持可读行长) */
/** 对话列宽(ChatView 与云端任务视图共用,两处几何保持一致) */
export const COL_MAX = "clamp(680px, 55vw, 860px)";

export const basename = (p: string) => p.replace(/[\/\\]+$/, "").split(/[\/\\]/).pop() || p;

// 输入法(IME)组合态的 Enter 只是确认候选词,不能当作提交。Chromium 上该 keydown
// 的 isComposing 为 true 即可拦截;但 WebKit(macOS 壳的 WKWebView)顺序相反:
// compositionend 先于 keydown 触发且 isComposing 已复位。故再记录组合结束时刻,
// 紧随其后的 Enter(同一次按键,时间差远小于人手连按)一律视为选字确认。
let imeEndedAt = -Infinity;
export const markImeEnd = (e: { timeStamp: number }) => {
  imeEndedAt = e.timeStamp;
};
export const isImeEnter = (e: { timeStamp: number; nativeEvent: { isComposing: boolean } }) =>
  e.nativeEvent.isComposing || e.timeStamp - imeEndedAt < 100;

/** 上下文用量圆环(设计稿 composer 的 ctx ring):悬停展示精确数字气泡
 * (自定义气泡而非 title:WKWebView 的原生提示不可靠且出现慢) */
function ContextRing({ usage }: { usage: Usage | null }) {
  const [hover, setHover] = useState(false);
  const C = 2 * Math.PI * 7;
  const frac = usage && usage.size > 0 ? usage.used / usage.size : 0;
  const dash = (C * Math.max(0.03, Math.min(1, frac))).toFixed(1) + " " + C.toFixed(1);
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: "relative", display: "flex", flex: "none", cursor: "default" }}
    >
      <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="7" stroke="var(--track)" strokeWidth="2" />
        <circle
          cx="9"
          cy="9"
          r="7"
          stroke={frac > 0.85 ? "var(--err)" : "var(--acc)"}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={dash}
          transform="rotate(-90 9 9)"
        />
      </svg>
      {hover && (
        <span
          className="pop"
          style={{
            position: "absolute",
            bottom: 26,
            right: -6,
            borderRadius: 8,
            padding: "7px 11px",
            gap: 3,
            whiteSpace: "nowrap",
            animation: "mcin .12s ease",
          }}
        >
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--t5)" }}>上下文用量</span>
          {usage ? (
            <>
              <span style={{ font: "12px " + MONO, color: "var(--t1)" }}>
                {usage.used.toLocaleString()} / {usage.size.toLocaleString()} tokens
              </span>
              <span style={{ fontSize: 11, color: frac > 0.85 ? "var(--err)" : "var(--t4)" }}>
                已用 {(frac * 100).toFixed(1)}%
                {frac > 0.85 ? " · 接近上限,即将自动压缩" : `,剩余 ${fmtK(Math.max(0, usage.size - usage.used))}`}
              </span>
            </>
          ) : (
            <span style={{ fontSize: 11.5, color: "var(--t4)" }}>暂无数据,本轮请求后更新</span>
          )}
        </span>
      )}
    </span>
  );
}

/** 权限模式 pill:默认权限 / YOLO 点击互切(⇧⇥ 同) */
function PermPill({ yolo, onToggle }: { yolo: boolean; onToggle: () => void }) {
  const fg = yolo ? "var(--warn)" : "var(--t3)";
  return (
    <button
      title="点击切换权限模式 (⇧⇥);YOLO 下所有操作不再询问,直接执行"
      onClick={onToggle}
      style={{
        height: 24,
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "0 9px",
        borderRadius: 12,
        border: `1px solid ${yolo ? "var(--warnBd)" : "var(--btnBd)"}`,
        background: yolo ? "var(--warnBg)" : "transparent",
        color: fg,
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
        flex: "none",
      }}
    >
      <IconShield color={fg} />
      {yolo ? "YOLO" : "默认权限"}
    </button>
  );
}

/** 模型选择按钮 + 上弹菜单(按来源分组;模型多时带过滤框) */
export function ModelPicker({
  models,
  current,
  disabled,
  onPick,
}: {
  models: ModelInfo[];
  current: string;
  disabled?: boolean;
  onPick: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const q = filter.trim().toLowerCase();
  const shown = q ? models.filter((m) => m.name.toLowerCase().includes(q)) : models;
  // 按来源分桶:「自定义」(无 source)恒在前,其余组按首次出现顺序
  const groups: { label: string; items: ModelInfo[] }[] = [];
  for (const m of shown) {
    const label = modelSourceLabel(m.source);
    let g = groups.find((x) => x.label === label);
    if (!g) {
      g = { label, items: [] };
      if (!m.source) groups.unshift(g);
      else groups.push(g);
    }
    g.items.push(m);
  }
  const showFilter = models.length > 10;

  return (
    <div style={{ position: "relative", flex: "none" }}>
      <button
        className={disabled ? undefined : "hv"}
        title={disabled ? "轮次执行中,结束后可切换" : "切换模型(下一轮生效)"}
        onClick={() => {
          if (disabled) return;
          setFilter("");
          setOpen(!open);
        }}
        style={{
          height: 24,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 7px",
          border: "none",
          borderRadius: 6,
          background: "transparent",
          fontSize: 12,
          color: disabled ? "var(--t5)" : "var(--t3)",
          cursor: disabled ? "default" : "pointer",
          fontWeight: 500,
        }}
      >
        {current || "模型"}
        <IconChevronDown style={{ marginTop: 1 }} />
      </button>
      {open && (
        <>
          <div className="backdrop" onClick={() => setOpen(false)} />
          <div className="pop" style={{ position: "absolute", bottom: 30, right: 0, minWidth: 220 }}>
            {showFilter && (
              <div style={{ padding: "6px 8px 4px" }}>
                <input
                  autoFocus
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="过滤模型…"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    height: 26,
                    padding: "0 8px",
                    fontSize: 12,
                    border: "1px solid var(--inputBd)",
                    borderRadius: 6,
                    background: "var(--bg)",
                    color: "var(--t2)",
                    outline: "none",
                  }}
                />
              </div>
            )}
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {groups.length === 0 && (
                <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--t5)" }}>无匹配模型</div>
              )}
              {groups.map((g) => (
                <div key={g.label}>
                  {(groups.length > 1 || g.label !== "自定义") && (
                    <div style={{ padding: "6px 10px 3px", fontSize: 10.5, fontWeight: 700, color: "var(--t5)", letterSpacing: 0.4 }}>
                      {g.label}
                    </div>
                  )}
                  {g.items.map((m) => (
                    <button
                      key={m.name}
                      className="hv menu-item"
                      onClick={() => {
                        setOpen(false);
                        onPick(m.name);
                      }}
                      style={{
                        padding: "7px 10px",
                        color: m.name === current ? "var(--acc)" : "var(--t2)",
                        fontWeight: m.name === current ? 600 : 400,
                      }}
                    >
                      {m.name}
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--t5)", fontWeight: 400 }}>
                        {m.default ? "默认" : ""}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function ChatView({
  meta,
  session,
  models,
  currentModel,
  onOpenDrawer,
  onOpenChild,
  onArchive,
  onDelete,
}: {
  meta: SessionMeta | undefined;
  /** 会话句柄(协议状态与动作,useSession) */
  session: SessionHandle;
  models: ModelInfo[];
  /** 展示用模型名(session.model 为空时 App 已回退默认) */
  currentModel: string;
  onOpenDrawer: (tab?: "files" | "changes") => void;
  onOpenChild: (id: string) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { chat, input, queued, atts, yolo } = session;
  const changesCount = session.changes?.length ?? 0;
  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true); // 用户是否停留在底部(自动跟随滚动)
  // 待恢复的锚点;回放期间每批都重新对齐(上方内容变高也不漂),用户主动滚动后交还控制权
  const restoreRef = useRef<{ anchor: number; offset: number } | null>(null);
  const [menu, setMenu] = useState<"closed" | "open" | "confirm">("closed");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0); // dragenter/leave 在子元素间反复触发,计数配对

  // 会话切换:复位跟随状态并取出记忆位置。ChatView 不按会话重挂载,
  // 不显式复位的话 pinnedRef 会带着上一会话的值进入新会话(切过来停在顶部的根因)
  useLayoutEffect(() => {
    const saved = session.id ? scrollMemo.get(session.id) : undefined;
    pinnedRef.current = saved ? saved.pinned : true; // 首次打开默认贴底
    restoreRef.current = saved && !saved.pinned ? { anchor: saved.anchor, offset: saved.offset } : null;
    if (!restoreRef.current) return;
    // 渲染后布局还会无事件地微调一次(实测 ~6px,RO 也抓不到这种再分配):
    // 恢复期间低频轮询对齐兜底,对齐到位后是零修正的空转,用户接管即停
    const iv = window.setInterval(() => {
      if (restoreRef.current) alignLog();
      else clearInterval(iv);
    }, 200);
    return () => clearInterval(iv);
  }, [session.id]);

  // 自动滚动:优先对齐记忆锚点,否则贴底跟随
  const alignLog = () => {
    const el = logRef.current;
    if (!el) return;
    const a = restoreRef.current;
    if (a) {
      const kids = el.firstElementChild?.children;
      // 锚点条目还没回放出来时先不动(停在已回放内容的开头),出来后逐批对齐
      if (kids && a.anchor < kids.length) {
        const r = kids[a.anchor].getBoundingClientRect();
        el.scrollTop += r.top - el.getBoundingClientRect().top + a.offset;
      }
    } else if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  };
  useEffect(alignLog, [chat.items, chat.running]);

  // 图片解码/字体加载等异步高度变化不经过 items,回放结束后仍会把位置顶漂
  // (实测漂 6px):监听内容列高度做兜底重对齐。用户接管后(restore 清空且
  // 未贴底)此路径自然不动作
  const hasLog = chat.items.length > 0;
  useEffect(() => {
    const col = logRef.current?.firstElementChild;
    if (!col) return;
    const ro = new ResizeObserver(alignLog);
    ro.observe(col);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLog]);

  // 输入框随内容自适应高度
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  const saveAnchor = () => {
    const el = logRef.current;
    // 恢复进行中的程序滚动不写记忆,避免中途切走时锚点被半成品覆盖
    if (!el || !session.id || restoreRef.current) return;
    const elTop = el.getBoundingClientRect().top;
    let anchor = 0;
    let offset = 0;
    const kids = el.firstElementChild?.children ?? [];
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect();
      if (r.bottom > elTop) {
        // 视口顶部所在的条目:offset 为条目顶到视口顶的已滚过距离
        anchor = i;
        offset = elTop - r.top;
        break;
      }
    }
    scrollMemo.set(session.id, { anchor, offset, pinned: pinnedRef.current });
  };
  const saveTimer = useRef(0);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    // scroll 事件只做"贴底→跟随"的单向判定,离底不在这里判:程序滚动同样发
    // scroll 事件,回放中一批内容长高 >40px 就会把跟随误判成用户离底(实测
    // 卡在中途)。离底判定只认用户真实输入(onWheel/滚动条拖拽)
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) pinnedRef.current = true;
    saveAnchor();
    // 滚动停止后布局仍会微调一次(实测 ~6px,不发 scroll 事件),停稳后补一次校准
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(saveAnchor, 600);
  };

  // 用户主动介入即终止锚点恢复,交还滚动控制权;向上意图同时解除贴底跟随
  const cancelRestore = () => {
    restoreRef.current = null;
  };
  const onLogWheel = (e: ReactWheelEvent) => {
    cancelRestore();
    if (e.deltaY < 0) pinnedRef.current = false; // 向上滚 = 离开底部去看历史
  };
  const onLogMouseDown = (e: ReactMouseEvent) => {
    cancelRestore();
    // 按在右缘滚动条带上 = 准备拖动定位,解除跟随(拖回底部会经 scroll 事件重新贴上)
    const el = logRef.current;
    if (el && e.clientX > el.getBoundingClientRect().right - 20) pinnedRef.current = false;
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组合态(选字/确认候选)的 Enter 不发送
    if (e.key === "Enter" && !e.shiftKey && !isImeEnter(e)) {
      e.preventDefault();
      session.send();
    }
  };

  // 粘贴附件:剪贴板里的 file item(截图/复制的文件)上传为附件,文本粘贴不受影响
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      void session.addFiles(files);
    }
  };

  // 拖拽文件进对话区
  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (![...e.dataTransfer.items].some((i) => i.kind === "file")) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (--dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) void session.addFiles(files);
  };

  const workdir = meta?.workdir ?? "";
  const empty = chat.items.length === 0 && !chat.running;
  const openPerm = [...chat.items].reverse().find((it) => it.kind === "perm" && it.state === "open") as
    | Extract<LogItem, { kind: "perm" }>
    | undefined;
  const anyToolRunning = chat.items.some((it) => it.kind === "tool" && it.status === "run");
  const runningLabel = openPerm ? "等待权限确认" : anyToolRunning ? "执行中" : "思考中";
  const roundNo = Math.max(1, chat.items.filter((it) => it.kind === "user").length);
  const usage = chat.usage;

  return (
    <div
      style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, position: "relative" }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div
          style={{
            position: "absolute",
            inset: 8,
            zIndex: 20,
            border: "2px dashed var(--acc)",
            borderRadius: 14,
            background: "var(--accBgSoft)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            fontSize: 14,
            fontWeight: 700,
            color: "var(--acc)",
          }}
        >
          松开以添加文件
        </div>
      )}
      {/* ==== 标题栏(空白区可拖拽窗口,macOS 常规行为)==== */}
      <div data-tauri-drag-region="" style={{ height: 56, flex: "none", display: "flex", alignItems: "center", gap: 12, padding: "0 24px", borderBottom: "1px solid var(--line2)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span className="ellipsis" style={{ fontWeight: 700, fontSize: 13.5 }}>
            {meta?.title || "新任务"}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--t5)", minWidth: 0 }}>
            <IconFolder size={11} color="var(--t6)" />
            <span style={{ fontWeight: 600, color: "var(--t3)", flex: "none" }}>{basename(workdir)}</span>
            <span style={{ color: "var(--t7)", flex: "none" }}>·</span>
            <span className="ellipsis" style={{ fontFamily: MONO }}>{workdir}</span>
          </span>
        </div>
        <span data-tauri-drag-region="" style={{ flex: 1, alignSelf: "stretch" }} />
        <button
          className="hv"
          title="浏览工作区文件(标注本轮改动)"
          onClick={() => onOpenDrawer()}
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
          {changesCount > 0 && (
            <span
              title="查看本轮改动"
              onClick={(e) => {
                e.stopPropagation();
                onOpenDrawer("changes");
              }}
              style={{
                minWidth: 16,
                height: 16,
                borderRadius: 8,
                background: "var(--accBg)",
                color: "var(--acc)",
                fontSize: 10.5,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "0 4px",
              }}
            >
              {changesCount}
            </span>
          )}
        </button>
        <div style={{ position: "relative", flex: "none" }}>
          <button
            className="hv icon-btn"
            title="更多"
            onClick={() => setMenu(menu === "closed" ? "open" : "closed")}
            style={{ width: 28, height: 28, borderRadius: 8, background: menu !== "closed" ? "var(--hov)" : "transparent" }}
          >
            <IconDots size={14} color="var(--t5)" />
          </button>
          {menu !== "closed" && (
            <>
              <div className="backdrop" onClick={() => setMenu("closed")} />
              <div className="pop" style={{ position: "absolute", top: 32, right: 0, minWidth: 118 }}>
                {menu === "open" ? (
                  <>
                    <button
                      className="hv menu-item"
                      onClick={() => {
                        setMenu("closed");
                        onArchive();
                      }}
                    >
                      <IconArchive />
                      {meta?.archived ? "取消归档" : "归档"}
                    </button>
                    {chat.running ? (
                      <button className="menu-item" style={{ cursor: "default", color: "var(--t5)" }} title="运行中,请先停止">
                        <IconTrash color="var(--t5)" />
                        删除
                      </button>
                    ) : (
                      <button className="hv-errbg menu-item" style={{ color: "var(--err)" }} onClick={() => setMenu("confirm")}>
                        <IconTrash />
                        删除
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ padding: "6px 9px 4px", fontSize: 11.5, color: "var(--t4)", lineHeight: 1.6, maxWidth: 200, whiteSpace: "normal" }}>
                      删除后不可恢复。
                      {meta?.worktree ? "隔离工作区及未应用改动将一并删除。" : ""}
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        className="hv-errbg menu-item"
                        style={{ color: "var(--err)", fontWeight: 600 }}
                        onClick={() => {
                          setMenu("closed");
                          onDelete();
                        }}
                      >
                        确认删除
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

      {/* ==== 对话流 / 空态 ==== */}
      {empty ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
          <img src={logoUrl} alt="" draggable={false} style={{ width: 52, height: 52 }} />
          <div style={{ fontSize: 15, fontWeight: 700, textAlign: "center", maxWidth: 420 }}>
            在 <span style={{ whiteSpace: "nowrap", fontFamily: MONO, fontSize: 13.5 }}>{workdir}</span> 开始新任务
          </div>
          <div style={{ fontSize: 12.5, color: "var(--t5)", textAlign: "center", lineHeight: 1.6 }}>
            描述你想做的事,比如修一个 Bug、加一个功能、
            <br />
            或者让我先看看这个项目。
          </div>
        </div>
      ) : (
        // scrollbar-gutter 两侧对称预留(Chromium 94+):滚动条出现时内容列不再被挤得比 composer 偏左
        <div
          ref={logRef}
          onScroll={onLogScroll}
          onWheel={onLogWheel}
          onTouchStart={cancelRestore}
          onMouseDown={onLogMouseDown}
          style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0, scrollbarGutter: "stable both-edges" }}
        >
          <div style={{ maxWidth: COL_MAX, margin: "0 auto", padding: "26px 36px 16px", display: "flex", flexDirection: "column", gap: 18 }}>
            <LogList items={chat.items} onPermAnswer={session.answerPerm} onOpenChild={onOpenChild} uploadUrl={session.uploadUrl} workdir={workdir} />
          </div>
        </div>
      )}

      {/* ==== 运行条 + 排队 + composer(680 列,钉在底部)====
          width 扣掉 16px:对话列在滚动容器内被 scrollbar-gutter 双侧各让 8px,
          composer 在容器外,同步扣减后两列在任意窗口宽度下公式一致、像素对齐 */}
      <div style={{ flex: "none", maxWidth: COL_MAX, width: "calc(100% - 16px)", margin: "0 auto", padding: "0 36px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
        {chat.running && (
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span className="spinner" />
            <span style={{ fontWeight: 600, fontSize: 12.5 }}>{runningLabel}</span>
            <span style={{ fontSize: 12, color: "var(--t5)" }}>
              第 {roundNo} 轮{usage ? ` · 已用 ${fmtK(usage.used)} tokens` : ""}
            </span>
            <span style={{ flex: 1 }} />
            <button
              className="hv-errbg"
              onClick={session.stop}
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

        {queued && (
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
            <span style={{ color: "var(--t6)", flex: "none", fontSize: 11.5 }}>运行结束后自动发送</span>
            <button className="hv2 icon-btn" title="取消排队" onClick={session.clearQueued} style={{ width: 20, height: 20, borderRadius: 5 }}>
              <IconX />
            </button>
          </div>
        )}

        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--inputBd)",
            borderRadius: 12,
            boxShadow: "var(--panelSh)",
            display: "flex",
            flexDirection: "column",
            // 光学对齐:硬边卡片向两侧出血 12px,卡内文字(textarea 左内距 15px)
            // 与对话文字左缘几乎重合,消除"输入框显窄"的错觉
            margin: "0 -12px",
          }}
        >
          {atts.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "10px 12px 0" }}>
              {atts.map((a, i) => (
                <span key={a.path} style={{ position: "relative", display: "flex" }}>
                  {a.isImage ? (
                    <img
                      src={a.preview}
                      alt={a.path}
                      title={a.path}
                      style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 8, border: "1px solid var(--cardBd)" }}
                    />
                  ) : (
                    <span
                      title={a.path}
                      style={{
                        height: 30,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "0 10px",
                        borderRadius: 8,
                        border: "1px solid var(--cardBd)",
                        background: "var(--codeBg)",
                        fontSize: 12,
                        color: "var(--t2)",
                        maxWidth: 220,
                      }}
                    >
                      <IconFolder size={12} color="var(--t4)" />
                      <span className="ellipsis">{a.name}</span>
                    </span>
                  )}
                  <button
                    className="icon-btn"
                    title="移除"
                    onClick={() => session.removeAtt(i)}
                    style={{
                      position: "absolute",
                      top: -5,
                      right: -5,
                      width: 17,
                      height: 17,
                      border: "1px solid var(--line)",
                      borderRadius: "50%",
                      background: "var(--card)",
                      boxShadow: "var(--cardSh)",
                    }}
                  >
                    <IconX size={8} color="var(--t3)" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            rows={2}
            value={input}
            placeholder={chat.running ? "补充说明…运行中发送会排队" : "输入任务…粘贴或拖入图片/文件可作为附件"}
            onChange={(e) => session.setInput(e.target.value)}
            onCompositionEnd={markImeEnd}
            onKeyDown={onKey}
            onPaste={onPaste}
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
            <PermPill yolo={yolo} onToggle={() => void session.toggleYolo()} />
            <span style={{ flex: 1 }} />
            <ModelPicker models={models} current={currentModel} disabled={chat.running} onPick={(name) => void session.switchModel(name)} />
            <ContextRing usage={usage} />
            <button
              className="hv-acc icon-btn"
              title="发送 ↩ · 换行 ⇧↩"
              onClick={session.send}
              style={{ width: 27, height: 27, borderRadius: 8, background: "var(--acc)", opacity: input.trim() || atts.length > 0 ? 1 : 0.45 }}
            >
              <IconSend />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
