// 展示型组件:消息、思考、工具卡片、计划卡、审批卡、diff 等。
// 样式值取自「MonkeyCode 原型(离线版)」的内联样式,逐一对应,不另行发挥。
import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { openExternal } from "./client";
import { permStateLabel } from "./reduce";
import type { LogItem, PlanEntry, SessionMeta } from "./types";

marked.setOptions({ gfm: true, breaks: true });

export const MONO = "ui-monospace,Menlo,monospace";

/** 正文里的链接一律不走 webview 导航(WKWebView 里点 <a> 会把应用页面跳走):
 * http(s) 交系统浏览器/新标签页,其余协议直接拦下。 */
function onMarkdownClick(e: ReactMouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") || "";
  if (/^https?:/i.test(href)) openExternal(href);
}

/** agent 正文按 Markdown 渲染(净化后注入);流式期间随批次重渲染 */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="md" onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 会话行操作菜单项样式 */
const rowMenuItem: CSSProperties = {
  padding: "8px 12px",
  fontSize: 12.5,
  cursor: "pointer",
  whiteSpace: "nowrap",
  borderRadius: 8,
  userSelect: "none",
};

/** 侧栏会话行:名称 + 右侧状态/轮数(时间无信息量,不展示);
 * 悬停显示 ⋯ 操作菜单(归档/删除,删除需内联确认)。 */
export function SessionRow({
  meta,
  active,
  onClick,
  onArchive,
  onDelete,
}: {
  meta: SessionMeta;
  active: boolean;
  onClick: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false); // WKWebView 的 CSS :hover 不可靠,用状态控制
  const [menu, setMenu] = useState<"closed" | "open" | "confirm">("closed");
  // 菜单以 fixed 定位(脱离侧栏滚动容器的裁剪),按 ⋯ 的视口位置计算;
  // 底部空间不足(列表末尾几行)时向上弹,避免被视口/状态栏遮住
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number }>({ right: 0 });
  const running = meta.status === "running";
  const m = running
    ? { text: "运行中", color: "var(--amberT)" }
    : meta.status === "error"
      ? { text: "出错", color: "var(--err)" }
      : meta.status === "interrupted"
        ? { text: "已中断", color: "var(--t5)" }
        : { text: meta.turns > 0 ? meta.turns + " 轮" : "", color: "var(--t5)" };
  const closeMenu = () => setMenu("closed");
  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className="hv-cardh"
        title={meta.workdir}
        onClick={onClick}
        style={{
          background: active ? "var(--card2)" : "transparent",
          borderRadius: 10,
          padding: "9px 13px",
          cursor: "pointer",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: active ? 600 : 400,
            color: active ? "var(--t1)" : "var(--t3)",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{meta.title || "(未命名)"}</span>
          {meta.worktree && (
            <span
              title="隔离 worktree 会话"
              style={{
                flex: "none",
                fontSize: 10,
                fontWeight: 600,
                color: "var(--amberT)",
                background: "var(--amberBg)",
                borderRadius: 5,
                padding: "1px 6px",
              }}
            >
              隔离
            </span>
          )}
          {/* 右侧定高插槽:状态文字与 ⋯ 互换时行高恒定,避免悬停引起整列抖动 */}
          <span
            style={{
              marginLeft: "auto",
              flex: "none",
              height: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
            }}
          >
            {hover || menu !== "closed" ? (
              <span
                className="hv-t1"
                title="会话操作"
                onClick={(e) => {
                  e.stopPropagation();
                  if (menu !== "closed") return setMenu("closed");
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const up = r.bottom + 150 > window.innerHeight; // 预估菜单高度(确认态更高)
                  setPos({
                    right: Math.max(8, window.innerWidth - r.right),
                    ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
                  });
                  setMenu("open");
                }}
                style={{
                  font: "700 14px/16px system-ui",
                  color: "var(--t4)",
                  padding: "0 3px",
                  cursor: "pointer",
                }}
              >
                ⋯
              </span>
            ) : (
              <span style={{ font: "400 11px/16px system-ui", color: m.color }}>{m.text}</span>
            )}
          </span>
        </div>
      </div>
      {menu !== "closed" && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 29 }}
            onClick={(e) => {
              e.stopPropagation();
              closeMenu();
            }}
          />
          <div
            style={{
              position: "fixed",
              right: pos.right,
              top: pos.top,
              bottom: pos.bottom,
              zIndex: 30,
              background: "var(--pop)",
              border: "1px solid var(--line)",
              borderRadius: 10,
              boxShadow: "var(--shadow)",
              padding: 4,
              minWidth: 150,
              animation: "mcin .15s ease",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {menu === "open" ? (
              <>
                <div
                  className="hv-card"
                  style={rowMenuItem}
                  onClick={() => {
                    closeMenu();
                    onArchive();
                  }}
                >
                  {meta.archived ? "取消归档" : "归档"}
                </div>
                {running ? (
                  <div style={{ ...rowMenuItem, cursor: "default", color: "var(--t5)" }} title="运行中,请先停止">
                    删除
                  </div>
                ) : (
                  <div
                    className="hv-card"
                    style={{ ...rowMenuItem, color: "var(--err)" }}
                    onClick={() => setMenu("confirm")}
                  >
                    删除
                  </div>
                )}
              </>
            ) : (
              <>
                <div
                  style={{
                    padding: "8px 12px 4px",
                    fontSize: 11.5,
                    color: "var(--t4)",
                    lineHeight: 1.6,
                    maxWidth: 200,
                    whiteSpace: "normal",
                  }}
                >
                  删除后不可恢复。
                  {meta.worktree ? "隔离工作区及未应用改动将一并删除。" : ""}
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <div
                    className="hv-card"
                    style={{ ...rowMenuItem, color: "var(--err)", fontWeight: 600 }}
                    onClick={() => {
                      closeMenu();
                      onDelete();
                    }}
                  >
                    确认删除
                  </div>
                  <div className="hv-card" style={rowMenuItem} onClick={closeMenu}>
                    取消
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 思考块:默认折叠为「✦ 思考 — 摘要 ▸」一行,点击展开(原型 thinking) */
function ThoughtView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const summary = text.trim().split("\n")[0] || "…";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        className="hv-t3"
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          fontSize: 12,
          color: "var(--t4)",
          cursor: "pointer",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        <span style={{ flex: "none" }}>✦ 思考</span>
        <span style={{ color: "var(--t5)", overflow: "hidden", textOverflow: "ellipsis" }}>— {summary}</span>
        <span style={{ color: "var(--t5)", flex: "none" }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div
          style={{
            borderLeft: "2px solid var(--line)",
            padding: "2px 0 2px 14px",
            fontSize: 12.5,
            color: "var(--t4)",
            lineHeight: 1.8,
            whiteSpace: "pre-wrap",
            animation: "mcin .2s ease",
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function PlanCard({ entries }: { entries: PlanEntry[] }) {
  const mark = (s: string) => (s === "completed" ? "☑" : s === "in_progress" ? "◐" : "☐");
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 14,
        background: "var(--card)",
        padding: "13px 16px",
        fontSize: 12.5,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        animation: "mcin .25s ease",
      }}
    >
      {entries.map((e, i) => (
        <div
          key={i}
          style={{
            color: e.status === "completed" ? "var(--t5)" : e.status === "in_progress" ? "var(--amberT)" : "var(--t3)",
            textDecoration: e.status === "completed" ? "line-through" : "none",
          }}
        >
          <span style={{ display: "inline-block", width: 18 }}>{mark(e.status)}</span> {e.content}
        </div>
      ))}
    </div>
  );
}

function statusMark(status: "run" | "ok" | "fail") {
  return status === "run" ? "◌" : status === "ok" ? "✓" : "✗";
}

/** 进度滚动窗口:固定只展示最后几条,旧条目自然滚出(完整过程走"查看子会话")。 */
const FEED_WINDOW = 5;

function ToolCard({
  item,
  radius,
  onOpenChild,
}: {
  item: Extract<LogItem, { kind: "tool" }>;
  radius: string;
  onOpenChild?: (id: string) => void;
}) {
  const feed = item.feed ?? [];
  const visible = feed.slice(-FEED_WINDOW);
  // 标题按「动词 目标」拆开:动词弱化(t3)、目标等宽突出(t1),对应原型 verb/target
  const sp = item.title.indexOf(" ");
  const verb = sp > 0 ? item.title.slice(0, sp) : "";
  const target = sp > 0 ? item.title.slice(sp + 1) : item.title;
  const subStyle = {
    display: "flex",
    gap: 8,
    alignItems: "baseline",
    padding: "0 14px 7px 35px",
    font: "11.5px/1.7 " + MONO,
    color: "var(--t4)",
    whiteSpace: "nowrap",
    minWidth: 0,
  } as const;
  return (
    <div style={{ background: "var(--card)", borderRadius: radius, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "9px 14px",
          fontSize: 12.5,
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        <span
          style={{
            color: item.status === "run" ? "var(--t4)" : item.status === "ok" ? "var(--ok)" : "var(--err)",
            fontSize: 11,
            flex: "none",
            display: "inline-block",
            animation: item.status === "run" ? "mcspin 1s linear infinite" : "none",
          }}
        >
          {statusMark(item.status)}
        </span>
        {verb && <span style={{ color: "var(--t3)", flex: "none" }}>{verb}</span>}
        <span style={{ font: "12px " + MONO, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {target}
        </span>
        {item.childSessionId && onOpenChild && (
          <span
            className="hv-t1"
            onClick={() => onOpenChild(item.childSessionId!)}
            style={{ font: "11.5px " + MONO, color: "var(--amberT)", cursor: "pointer", flex: "none" }}
          >
            查看子会话
          </span>
        )}
        {item.out && (
          <span
            style={{
              marginLeft: "auto",
              color: "var(--t5)",
              fontSize: 11,
              flex: "none",
              maxWidth: "45%",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {item.out}
          </span>
        )}
      </div>
      {visible.map((s, i) => (
        <div key={feed.length - visible.length + i} style={subStyle}>
          <span style={{ color: "var(--t5)", flex: "none" }}>↳</span>
          {s.kind === "tool" ? (
            <>
              <span
                style={{
                  color: s.status === "run" ? "var(--t4)" : s.status === "ok" ? "var(--ok)" : "var(--err)",
                  fontSize: 10,
                  flex: "none",
                }}
              >
                {statusMark(s.status)}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{s.title}</span>
            </>
          ) : (
            <span style={{ color: "var(--t5)", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
              {s.text}
            </span>
          )}
        </div>
      ))}
      {item.status === "run" && item.lastLine && (
        <div
          style={{
            ...subStyle,
            display: "block",
            color: "var(--t5)",
            fontStyle: "italic",
            overflow: "hidden",
            textOverflow: "ellipsis",
            animation: "mcpulse 1.2s infinite",
          }}
        >
          ↳ {item.lastLine}
        </div>
      )}
    </div>
  );
}

/** 审批卡终态文案(原型 resolvedText 风格) */
function permResolved(state: string): { text: string; color: string } {
  switch (state) {
    case "allowed":
    case "approved":
      return { text: "✓ 已允许", color: "var(--ok)" };
    case "rejected":
    case "denied":
      return { text: "✕ 已拒绝", color: "var(--err)" };
    case "timeout":
      return { text: "✕ " + permStateLabel(state), color: "var(--err)" };
    default:
      return { text: permStateLabel(state), color: "var(--t5)" };
  }
}

function PermCard({
  item,
  onAnswer,
}: {
  item: Extract<LogItem, { kind: "perm" }>;
  onAnswer: (id: string, action: "allow" | "always" | "persist" | "deny") => void;
}) {
  const btn = {
    padding: "7px 18px",
    background: "var(--card2)",
    color: "var(--t2)",
    borderRadius: 9,
    cursor: "pointer",
  } as const;
  return (
    <div
      style={{
        border: "1px solid var(--amberBd)",
        borderRadius: 14,
        background: "var(--amberBg)",
        padding: "15px 17px",
        maxWidth: 540,
        animation: "mcin .25s ease",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--amberT)", whiteSpace: "nowrap" }}>
        需要确认 · {item.tool || "执行操作"}
      </div>
      <div
        style={{
          margin: "10px 0 12px",
          padding: "9px 13px",
          background: "var(--codeBg)",
          borderRadius: 9,
          font: "12.5px " + MONO,
          color: "var(--t1)",
          wordBreak: "break-all",
        }}
      >
        {item.title}
      </div>
      {item.state === "open" ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, fontWeight: 600, flexWrap: "wrap" }}>
          <div
            className="hv-op"
            onClick={() => onAnswer(item.id, "allow")}
            style={{ ...btn, background: "var(--amber)", color: "var(--onAmber)" }}
          >
            允许
          </div>
          <div className="hv-cardh" onClick={() => onAnswer(item.id, "always")} style={btn}>
            本会话始终
          </div>
          <div className="hv-cardh" onClick={() => onAnswer(item.id, "persist")} style={btn}>
            此项目永久
          </div>
          <div
            className="hv-err"
            onClick={() => onAnswer(item.id, "deny")}
            style={{ padding: "7px 14px", color: "var(--t4)", borderRadius: 9, cursor: "pointer" }}
          >
            拒绝
          </div>
          <span style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11, color: "var(--t5)" }}>
            ⏎ 允许 · esc 拒绝
          </span>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: permResolved(item.state).color }}>{permResolved(item.state).text}</div>
      )}
    </div>
  );
}

function ItemView({
  item,
  onPermAnswer,
}: {
  item: Exclude<LogItem, { kind: "tool" }>;
  onPermAnswer: (id: string, action: "allow" | "always" | "persist" | "deny") => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div
          style={{
            alignSelf: "flex-end",
            maxWidth: "70%",
            background: "var(--card2)",
            borderRadius: "16px 16px 5px 16px",
            padding: "10px 16px",
            color: "var(--t1)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            animation: "mcin .25s ease",
          }}
        >
          {item.text}
        </div>
      );
    case "agent":
      return (
        <div style={{ maxWidth: "90%", color: "var(--t2)", wordBreak: "break-word", animation: "mcin .25s ease" }}>
          <Markdown text={item.text} />
        </div>
      );
    case "thought":
      return <ThoughtView text={item.text} />;
    case "plan":
      return <PlanCard entries={item.entries} />;
    case "sys":
      return (
        <div style={{ color: item.error ? "var(--err)" : "var(--t5)", fontSize: 11.5, textAlign: "center" }}>
          {item.text}
        </div>
      );
    case "perm":
      return <PermCard item={item} onAnswer={onPermAnswer} />;
  }
}

/** 对话流:相邻工具项聚成一组(1px 缝隙 + 端部大圆角,与原型 t.radius 方案一致) */
export function LogList({
  items,
  onPermAnswer,
  onOpenChild,
}: {
  items: LogItem[];
  onPermAnswer: (id: string, action: "allow" | "always" | "persist" | "deny") => void;
  onOpenChild?: (id: string) => void;
}) {
  const out: ReactElement[] = [];
  for (let i = 0; i < items.length; ) {
    const it = items[i];
    if (it.kind === "tool") {
      const start = i;
      const group: Extract<LogItem, { kind: "tool" }>[] = [];
      while (i < items.length) {
        const t = items[i];
        if (t.kind !== "tool") break;
        group.push(t);
        i++;
      }
      const n = group.length;
      out.push(
        <div key={"g" + start} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {group.map((t, j) => (
            <ToolCard
              key={t.tcId || j}
              item={t}
              onOpenChild={onOpenChild}
              radius={n === 1 ? "11px" : j === 0 ? "11px 11px 4px 4px" : j === n - 1 ? "4px 4px 11px 11px" : "4px"}
            />
          ))}
        </div>,
      );
    } else {
      out.push(<ItemView key={i} item={it} onPermAnswer={onPermAnswer} />);
      i++;
    }
  }
  return <>{out}</>;
}

interface DiffRow {
  no: string;
  text: string;
  kind: "h" | "add" | "del" | "ctx";
}

/** unified diff → 带行号的行(行号取新文件侧,删除行取旧文件侧,同原型演示数据) */
function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldN = 0;
  let newN = 0;
  for (const line of text.split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      oldN = +m[1];
      newN = +m[2];
      rows.push({ no: "", text: line, kind: "h" });
      continue;
    }
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity") ||
      line.startsWith("rename") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode")
    )
      continue;
    if (line.startsWith("+")) {
      rows.push({ no: String(newN++), text: line, kind: "add" });
    } else if (line.startsWith("-")) {
      rows.push({ no: String(oldN++), text: line, kind: "del" });
    } else {
      rows.push({ no: String(newN), text: line, kind: "ctx" });
      oldN++;
      newN++;
    }
  }
  return rows;
}

/** diff 面板(原型改动抽屉的行渲染:36px 行号列 + hunk 灰条 + 增删着色) */
export function DiffPanel({ text }: { text: string }) {
  const rows = useMemo(() => parseDiff(text), [text]);
  if (!rows.some((r) => r.kind === "h")) {
    // 非 diff 内容(加载中/错误/无差异提示)
    return (
      <pre style={{ margin: 0, padding: "10px 24px", font: "12px/1.9 " + MONO, color: "var(--t4)", whiteSpace: "pre-wrap" }}>
        {text}
      </pre>
    );
  }
  return (
    <div style={{ font: "12px/1.9 " + MONO }}>
      {rows.map((r, i) =>
        r.kind === "h" ? (
          <div key={i} style={{ display: "flex", padding: "2px 24px", background: "var(--card)", color: "var(--t4)", fontSize: 11 }}>
            <span style={{ width: 36, flex: "none" }} />
            <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{r.text}</span>
          </div>
        ) : (
          <div
            key={i}
            style={{
              display: "flex",
              padding: "0 24px",
              background: r.kind === "add" ? "var(--addBg)" : r.kind === "del" ? "var(--delBg)" : "transparent",
              color: r.kind === "add" ? "var(--addT)" : r.kind === "del" ? "var(--delT)" : "var(--t3)",
            }}
          >
            <span style={{ width: 36, color: "var(--t5)", flex: "none", opacity: 0.6 }}>{r.no}</span>
            <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", minWidth: 0 }}>{r.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}
