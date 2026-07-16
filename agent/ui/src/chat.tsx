// 会话视图:标题栏 / 对话流 / 运行条 / 排队 chip / composer。
// 布局与数值取自设计稿 Chat 屏;协议交互(发送/审批/切模型等)经 props 回调 App。
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { LogList, MONO } from "./components";
import {
  IconArchive,
  IconBranch,
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
import type { ChatState } from "./reduce";
import type { LogItem, ModelInfo, SessionMeta, Usage } from "./types";

const fmtK = (n: number) =>
  n >= 1_000_000 ? Math.round(n / 100_000) / 10 + "M" : n >= 1000 ? Math.round(n / 100) / 10 + "k" : String(n);

/** 对话/composer 共用列宽:680 起随窗口加宽,宽屏封顶 860(保持可读行长) */
const COL_MAX = "clamp(680px, 55vw, 860px)";

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

/** 上下文用量圆环(设计稿 composer 的 ctx ring) */
function ContextRing({ usage }: { usage: Usage | null }) {
  const C = 2 * Math.PI * 7;
  const frac = usage && usage.size > 0 ? usage.used / usage.size : 0;
  const dash = (C * Math.max(0.03, Math.min(1, frac))).toFixed(1) + " " + C.toFixed(1);
  const title = usage
    ? `上下文 ${fmtK(usage.used)} / ${fmtK(usage.size)} tokens (${(frac * 100).toFixed(1)}%)`
    : "上下文用量";
  return (
    <span title={title} style={{ display: "flex", flex: "none", cursor: "default" }}>
      <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="7" stroke="rgba(120,130,125,.25)" strokeWidth="2" />
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
        border: `1px solid ${yolo ? "var(--warnBd)" : "rgba(30,40,35,.16)"}`,
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

/** 模型选择按钮 + 上弹菜单 */
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
  return (
    <div style={{ position: "relative", flex: "none" }}>
      <button
        className={disabled ? undefined : "hv"}
        title={disabled ? "轮次执行中,结束后可切换" : "切换模型(下一轮生效)"}
        onClick={() => !disabled && setOpen(!open)}
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
          <div style={{ position: "fixed", inset: 0, zIndex: 29 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: "absolute",
              bottom: 30,
              right: 0,
              zIndex: 30,
              background: "var(--pop)",
              border: "1px solid var(--line)",
              borderRadius: 9,
              boxShadow: "var(--shadow)",
              padding: 4,
              minWidth: 200,
              display: "flex",
              flexDirection: "column",
              animation: "mcin .15s ease",
            }}
          >
            {models.map((m) => (
              <button
                key={m.name}
                className="hv"
                onClick={() => {
                  setOpen(false);
                  onPick(m.name);
                }}
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 10px",
                  borderRadius: 6,
                  fontSize: 12.5,
                  color: m.name === current ? "var(--acc)" : "var(--t2)",
                  fontWeight: m.name === current ? 600 : 400,
                  textAlign: "left",
                  whiteSpace: "nowrap",
                }}
              >
                {m.name}
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--t5)", fontWeight: 400 }}>
                  {m.default ? "默认" : ""}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ChatView({
  meta,
  chat,
  changesCount,
  input,
  setInput,
  queued,
  models,
  currentModel,
  yolo,
  atts,
  onAddImages,
  onRemoveAtt,
  uploadUrl,
  onSend,
  onStop,
  onClearQueued,
  onToggleYolo,
  onSwitchModel,
  onOpenDrawer,
  onPermAnswer,
  onOpenChild,
  onArchive,
  onDelete,
}: {
  meta: SessionMeta | undefined;
  chat: ChatState;
  changesCount: number;
  input: string;
  setInput: (v: string) => void;
  queued: string | null;
  models: ModelInfo[];
  currentModel: string;
  yolo: boolean;
  /** 待发送图片附件(已上传到工作区) */
  atts: { path: string; preview: string }[];
  onAddImages: (files: File[]) => void;
  onRemoveAtt: (i: number) => void;
  uploadUrl?: (path: string) => string;
  onSend: () => void;
  onStop: () => void;
  onClearQueued: () => void;
  onToggleYolo: () => void;
  onSwitchModel: (name: string) => void;
  onOpenDrawer: () => void;
  onPermAnswer: (id: string, action: "allow" | "always" | "persist" | "deny") => void;
  onOpenChild: (id: string) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true); // 用户是否停留在底部(自动跟随滚动)
  const [menu, setMenu] = useState<"closed" | "open" | "confirm">("closed");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0); // dragenter/leave 在子元素间反复触发,计数配对

  // 自动滚动(仅当用户停留在底部)
  useEffect(() => {
    const el = logRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [chat.items, chat.running]);

  // 输入框随内容自适应高度
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组合态(选字/确认候选)的 Enter 不发送
    if (e.key === "Enter" && !e.shiftKey && !isImeEnter(e)) {
      e.preventDefault();
      onSend();
    }
  };

  // 粘贴图片:剪贴板里的 image item 上传为附件(文本粘贴不受影响)
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      onAddImages(files);
    }
  };

  // 拖拽图片进对话区
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
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) onAddImages(files);
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

  const menuItem: CSSProperties = {
    border: "none",
    background: "transparent",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 9px",
    borderRadius: 6,
    fontSize: 12.5,
    color: "var(--t1)",
    textAlign: "left",
    whiteSpace: "nowrap",
  };

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
            background: "rgba(31,138,91,.06)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            fontSize: 14,
            fontWeight: 700,
            color: "var(--acc)",
          }}
        >
          松开以添加图片
        </div>
      )}
      {/* ==== 标题栏(空白区可拖拽窗口,macOS 常规行为)==== */}
      <div data-tauri-drag-region="" style={{ height: 56, flex: "none", display: "flex", alignItems: "center", gap: 12, padding: "0 24px", borderBottom: "1px solid var(--line2)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {meta?.title || "新任务"}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--t5)", minWidth: 0 }}>
            <IconFolder size={11} color="var(--t6)" />
            <span style={{ fontWeight: 600, color: "var(--t3)", flex: "none" }}>{basename(workdir)}</span>
            <span style={{ color: "#c4c9c3", flex: "none" }}>·</span>
            <span style={{ fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workdir}</span>
          </span>
        </div>
        <span data-tauri-drag-region="" style={{ flex: 1, alignSelf: "stretch" }} />
        <button
          className="hv"
          title="查看本轮文件改动"
          onClick={onOpenDrawer}
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
          <IconBranch />
          改动
          {changesCount > 0 && (
            <span
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
            className="hv"
            title="更多"
            onClick={() => setMenu(menu === "closed" ? "open" : "closed")}
            style={{
              width: 28,
              height: 28,
              border: "none",
              borderRadius: 8,
              background: menu !== "closed" ? "var(--hov)" : "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
            }}
          >
            <IconDots size={14} color="var(--t5)" />
          </button>
          {menu !== "closed" && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 29 }} onClick={() => setMenu("closed")} />
              <div
                style={{
                  position: "absolute",
                  top: 32,
                  right: 0,
                  zIndex: 30,
                  background: "var(--pop)",
                  border: "1px solid var(--line)",
                  borderRadius: 9,
                  boxShadow: "var(--shadow)",
                  padding: 4,
                  display: "flex",
                  flexDirection: "column",
                  minWidth: 118,
                  animation: "mcin .15s ease",
                }}
              >
                {menu === "open" ? (
                  <>
                    <button
                      className="hv"
                      style={menuItem}
                      onClick={() => {
                        setMenu("closed");
                        onArchive();
                      }}
                    >
                      <IconArchive />
                      {meta?.archived ? "取消归档" : "归档"}
                    </button>
                    {chat.running ? (
                      <button style={{ ...menuItem, cursor: "default", color: "var(--t5)" }} title="运行中,请先停止">
                        <IconTrash color="var(--t5)" />
                        删除
                      </button>
                    ) : (
                      <button className="hv-errbg" style={{ ...menuItem, color: "var(--err)" }} onClick={() => setMenu("confirm")}>
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
                        className="hv-errbg"
                        style={{ ...menuItem, color: "var(--err)", fontWeight: 600 }}
                        onClick={() => {
                          setMenu("closed");
                          onDelete();
                        }}
                      >
                        确认删除
                      </button>
                      <button className="hv" style={menuItem} onClick={() => setMenu("closed")}>
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
        <div ref={logRef} onScroll={onLogScroll} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0 }}>
          <div style={{ maxWidth: COL_MAX, margin: "0 auto", padding: "26px 36px 16px", display: "flex", flexDirection: "column", gap: 18 }}>
            <LogList items={chat.items} onPermAnswer={onPermAnswer} onOpenChild={onOpenChild} uploadUrl={uploadUrl} />
          </div>
        </div>
      )}

      {/* ==== 运行条 + 排队 + composer(680 列,钉在底部)==== */}
      <div style={{ flex: "none", maxWidth: COL_MAX, width: "100%", margin: "0 auto", padding: "0 36px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
        {chat.running && (
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span
              style={{
                width: 13,
                height: 13,
                border: "2px solid var(--acc)",
                borderTopColor: "transparent",
                borderRadius: "50%",
                animation: "mcspin .9s linear infinite",
                flex: "none",
              }}
            />
            <span style={{ fontWeight: 600, fontSize: 12.5 }}>{runningLabel}</span>
            <span style={{ fontSize: 12, color: "var(--t5)" }}>
              第 {roundNo} 轮{usage ? ` · 已用 ${fmtK(usage.used)} tokens` : ""}
            </span>
            <span style={{ flex: 1 }} />
            <button
              className="hv-errbg"
              onClick={onStop}
              style={{
                height: 26,
                border: "1px solid rgba(194,80,62,.3)",
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
              background: "rgba(255,255,255,.7)",
              border: "1px solid var(--cardBd)",
              borderRadius: 10,
              padding: "7px 12px",
              fontSize: 12,
            }}
          >
            <IconClock />
            <span style={{ color: "var(--t3)", flex: "none" }}>已排队</span>
            <span style={{ fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{queued}</span>
            <span style={{ color: "var(--t6)", flex: "none", fontSize: 11.5 }}>运行结束后自动发送</span>
            <button className="hv2" title="取消排队" onClick={onClearQueued} style={{ width: 20, height: 20, border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 5, flex: "none" }}>
              <IconX />
            </button>
          </div>
        )}

        <div
          style={{
            background: "rgba(255,255,255,.92)",
            border: "1px solid rgba(30,40,35,.13)",
            borderRadius: 12,
            boxShadow: "0 4px 20px rgba(30,45,38,.08)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {atts.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "10px 12px 0" }}>
              {atts.map((a, i) => (
                <span key={a.path} style={{ position: "relative", display: "flex" }}>
                  <img
                    src={a.preview}
                    alt={a.path}
                    title={a.path}
                    style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 8, border: "1px solid var(--cardBd)" }}
                  />
                  <button
                    title="移除"
                    onClick={() => onRemoveAtt(i)}
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
                      cursor: "pointer",
                      padding: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
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
            placeholder={chat.running ? "补充说明…运行中发送会排队" : "输入任务…粘贴或拖入图片可作为附件"}
            onChange={(e) => setInput(e.target.value)}
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
            <PermPill yolo={yolo} onToggle={onToggleYolo} />
            <span style={{ flex: 1 }} />
            <ModelPicker models={models} current={currentModel} disabled={chat.running} onPick={onSwitchModel} />
            <ContextRing usage={usage} />
            <button
              className="hv-acc"
              title="发送 ↩ · 换行 ⇧↩"
              onClick={onSend}
              style={{
                width: 27,
                height: 27,
                border: "none",
                borderRadius: 8,
                background: "var(--acc)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "none",
                opacity: input.trim() || atts.length > 0 ? 1 : 0.45,
              }}
            >
              <IconSend />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
