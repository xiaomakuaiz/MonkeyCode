// 展示型组件:消息、思考、工具卡片、计划卡、审批卡、diff 等。
// 样式值取自「MonkeyCode 桌面应用设计」(浅色绿调),逐一对应,不另行发挥。
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
import { IconCheck, IconChevronRight, IconSpark } from "./icons";
import { permStateLabel } from "./reduce";
import type { LogItem, PlanEntry } from "./types";

marked.setOptions({ gfm: true, breaks: true });

// 等宽栈:显式列出各平台字体,Windows 上不能只留 monospace 泛型——
// Win7 WebView2 对泛型的解析不可靠(显示乱码),中文回退也会掉进宋体位图
export const MONO = 'ui-monospace,Menlo,Consolas,"Courier New","Microsoft YaHei",monospace';

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

/** 思考块:单行折叠(✦ 思考 + 摘要省略),点击在下方展开完整文本的缩进块。
 * 全文不放进标题 flex 行:多行文本会把居中的图标顶到段落中部,标签与内容挤作一团。 */
function ThoughtView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: "var(--t4)",
          cursor: "pointer",
          userSelect: "none",
          lineHeight: 1.6,
          minWidth: 0,
        }}
      >
        <IconSpark />
        <span style={{ fontWeight: 600, color: "var(--t3)", flex: "none" }}>思考</span>
        {!open && (
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {text.trim().replace(/\s+/g, " ")}
          </span>
        )}
        {open && <span style={{ flex: 1 }} />}
        <IconChevronRight
          size={9}
          color="var(--t6)"
          style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s ease" }}
        />
      </div>
      {open && (
        <div
          style={{
            marginLeft: 5,
            borderLeft: "2px solid var(--line)",
            padding: "2px 0 2px 13px",
            fontSize: 12,
            color: "var(--t4)",
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            animation: "mcin .2s ease",
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

/** 白卡通用样式(工具/计划/子代理共用,设计稿 agent card) */
const cardStyle: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--cardBd)",
  borderRadius: 10,
  boxShadow: "var(--cardSh)",
  padding: "11px 14px",
};

function PlanCard({ entries }: { entries: PlanEntry[] }) {
  const mark = (s: string) => (s === "completed" ? "☑" : s === "in_progress" ? "◐" : "☐");
  return (
    <div style={{ ...cardStyle, fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4, animation: "mcin .25s ease" }}>
      {entries.map((e, i) => (
        <div
          key={i}
          style={{
            color: e.status === "completed" ? "var(--t5)" : e.status === "in_progress" ? "var(--acc)" : "var(--t2)",
            textDecoration: e.status === "completed" ? "line-through" : "none",
          }}
        >
          <span style={{ display: "inline-block", width: 18 }}>{mark(e.status)}</span> {e.content}
        </div>
      ))}
    </div>
  );
}

/** 状态圆点:执行中空心绿点呼吸,结束灰描边(设计稿 agents 的 dot) */
function StatusDot({ status }: { status: "run" | "ok" | "fail" }) {
  const run = status === "run";
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        flex: "none",
        border: `1.5px solid ${run ? "var(--acc)" : status === "ok" ? "var(--t5)" : "var(--err)"}`,
        background: run ? "var(--accBd)" : "transparent",
        animation: run ? "mcpulse 1.4s infinite" : "none",
      }}
    />
  );
}

function stepMark(status: "run" | "ok" | "fail") {
  if (status === "ok") return <IconCheck size={10} />;
  if (status === "fail") return <span style={{ color: "var(--err)", fontSize: 10, flex: "none" }}>✗</span>;
  return <span style={{ color: "var(--t5)", fontSize: 10, flex: "none", animation: "mcpulse 1.2s infinite" }}>◌</span>;
}

/** 进度滚动窗口:固定只展示最后几条,旧条目自然滚出(完整过程走"查看子会话")。 */
const FEED_WINDOW = 5;

export function ToolCard({
  item,
  onOpenChild,
}: {
  item: Extract<LogItem, { kind: "tool" }>;
  onOpenChild?: (id: string) => void;
}) {
  const feed = item.feed ?? [];
  const visible = feed.slice(-FEED_WINDOW);
  // 标题按「动词 目标」拆开:动词常规、目标等宽(设计稿 verb/target)
  const sp = item.title.indexOf(" ");
  const verb = sp > 0 ? item.title.slice(0, sp) : "";
  const target = sp > 0 ? item.title.slice(sp + 1) : item.title;
  const stepRow: CSSProperties = {
    display: "flex",
    gap: 7,
    alignItems: "center",
    paddingLeft: 15,
    font: "11px/1.7 " + MONO,
    color: "var(--t3)",
    whiteSpace: "nowrap",
    minWidth: 0,
  };
  return (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 7, fontSize: 12.5 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0, whiteSpace: "nowrap" }}>
        <StatusDot status={item.status} />
        {verb && <span style={{ fontWeight: 600, flex: "none", color: "var(--t1)" }}>{verb}</span>}
        <span style={{ color: "var(--t3)", font: "12px " + MONO, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {target}
        </span>
        <span style={{ flex: 1 }} />
        {item.out && (
          <span style={{ color: "var(--t5)", fontSize: 11, flex: "none", maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis" }}>
            {item.out}
          </span>
        )}
        {item.childSessionId && onOpenChild && (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onOpenChild(item.childSessionId!);
            }}
            style={{ fontSize: 11.5, fontWeight: 600, flex: "none" }}
          >
            查看子会话
          </a>
        )}
      </div>
      {visible.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {visible.map((s, i) => (
            <div key={feed.length - visible.length + i} style={stepRow}>
              {s.kind === "tool" ? (
                <>
                  {stepMark(s.status)}
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</span>
                </>
              ) : (
                <span style={{ color: "var(--t5)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {s.text}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {item.status === "run" && item.lastLine && (
        <div style={{ ...stepRow, display: "block", color: "var(--t5)", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", animation: "mcpulse 1.2s infinite" }}>
          {item.lastLine}
        </div>
      )}
    </div>
  );
}

/** 审批卡终态文案 */
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
  const btn: CSSProperties = {
    height: 28,
    display: "flex",
    alignItems: "center",
    padding: "0 14px",
    background: "var(--card)",
    border: "1px solid var(--line)",
    color: "var(--t2)",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 12.5,
    fontWeight: 600,
    userSelect: "none",
    whiteSpace: "nowrap",
  };
  return (
    <div
      style={{
        border: "1px solid var(--warnBd)",
        borderRadius: 12,
        background: "var(--warnBg)",
        padding: "13px 15px",
        maxWidth: 560,
        animation: "mcin .25s ease",
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--warn)", whiteSpace: "nowrap" }}>
        需要确认 · {item.tool || "执行操作"}
      </div>
      <div
        style={{
          margin: "9px 0 11px",
          padding: "8px 12px",
          background: "var(--card)",
          border: "1px solid var(--line2)",
          borderRadius: 8,
          font: "12.5px " + MONO,
          color: "var(--t1)",
          wordBreak: "break-all",
        }}
      >
        {item.title}
      </div>
      {item.state === "open" ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div
            className="hv-acc"
            onClick={() => onAnswer(item.id, "allow")}
            style={{ ...btn, background: "var(--acc)", borderColor: "var(--acc)", color: "var(--onAcc)" }}
          >
            允许
          </div>
          <div className="hv" onClick={() => onAnswer(item.id, "always")} style={btn}>
            本会话始终
          </div>
          <div className="hv" onClick={() => onAnswer(item.id, "persist")} style={btn}>
            此项目永久
          </div>
          <div
            className="hv-errbg"
            onClick={() => onAnswer(item.id, "deny")}
            style={{ ...btn, background: "transparent", border: "1px solid rgba(194,80,62,.3)", color: "var(--err)" }}
          >
            拒绝
          </div>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--t5)" }}>⏎ 允许 · esc 拒绝</span>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: permResolved(item.state).color }}>{permResolved(item.state).text}</div>
      )}
    </div>
  );
}

/** 轮次分隔线:横线 + 居中小字(设计稿"本轮结束") */
function TurnDivider() {
  const line = <span style={{ flex: 1, height: 1, background: "var(--line2)" }} />;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--t6)", fontSize: 10.5, letterSpacing: 1 }}>
      {line}
      本轮结束
      {line}
    </div>
  );
}

/** 用户消息里的附件行:`[图片]/[文件] <工作区相对路径>`(composer 发送时拼接的约定格式) */
const ATT_LINE = /^\[(图片|文件)\] (\S+)$/;

/** 用户气泡:文本 + 附图缩略图(点击看大图)+ 文件 chip(点击下载) */
function UserBubble({ text, uploadUrl }: { text: string; uploadUrl?: (path: string) => string }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const lines = text.split("\n");
  const images: string[] = [];
  const files: string[] = [];
  const rest: string[] = [];
  for (const line of lines) {
    const m = line.match(ATT_LINE);
    if (m && uploadUrl) (m[1] === "图片" ? images : files).push(m[2]);
    else rest.push(line);
  }
  const body = rest.join("\n").trim();
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <div
        style={{
          maxWidth: "70%",
          background: "var(--userBg)",
          border: "1px solid var(--accBd)",
          borderRadius: "12px 12px 3px 12px",
          padding: "9px 15px",
          fontSize: 13.5,
          lineHeight: 1.6,
          color: "var(--t1)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          animation: "mcin .25s ease",
        }}
      >
        {body}
        {(images.length > 0 || files.length > 0) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: body ? 8 : 2, alignItems: "center" }}>
            {images.map((p) => (
              <img
                key={p}
                src={uploadUrl!(p)}
                alt={p}
                title={p}
                onClick={() => setZoom(p)}
                style={{
                  maxWidth: 150,
                  maxHeight: 120,
                  borderRadius: 8,
                  border: "1px solid var(--accBd)",
                  cursor: "zoom-in",
                  display: "block",
                }}
              />
            ))}
            {files.map((p) => (
              <span
                key={p}
                title={p + "(点击下载)"}
                onClick={() => openExternal(new URL(uploadUrl!(p), location.origin).href)}
                style={{
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 10px",
                  borderRadius: 8,
                  border: "1px solid var(--accBd)",
                  background: "var(--card)",
                  fontSize: 12,
                  color: "var(--t2)",
                  maxWidth: 240,
                  cursor: "pointer",
                }}
              >
                📄
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.split("/").pop()}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
      {zoom && (
        <div
          onClick={() => setZoom(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(20,30,25,.55)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "zoom-out",
          }}
        >
          <img
            src={uploadUrl!(zoom)}
            alt={zoom}
            style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 10, boxShadow: "0 24px 70px rgba(0,0,0,.4)" }}
          />
        </div>
      )}
    </div>
  );
}

function ItemView({
  item,
  onPermAnswer,
  uploadUrl,
}: {
  item: Exclude<LogItem, { kind: "tool" }>;
  onPermAnswer: (id: string, action: "allow" | "always" | "persist" | "deny") => void;
  uploadUrl?: (path: string) => string;
}) {
  switch (item.kind) {
    case "user":
      return <UserBubble text={item.text} uploadUrl={uploadUrl} />;
    case "agent":
      return (
        <div style={{ maxWidth: "92%", wordBreak: "break-word", animation: "mcin .25s ease" }}>
          <Markdown text={item.text} />
        </div>
      );
    case "thought":
      return <ThoughtView text={item.text} />;
    case "plan":
      return <PlanCard entries={item.entries} />;
    case "sys":
      if (item.text === "— 本轮结束 —") return <TurnDivider />;
      return (
        <div style={{ color: item.error ? "var(--err)" : "var(--t5)", fontSize: 11.5, textAlign: "center" }}>
          {item.text}
        </div>
      );
    case "perm":
      return <PermCard item={item} onAnswer={onPermAnswer} />;
  }
}

/** 对话流:相邻工具卡聚成一列(间距 8,设计稿 agents 列) */
export function LogList({
  items,
  onPermAnswer,
  onOpenChild,
  uploadUrl,
}: {
  items: LogItem[];
  onPermAnswer: (id: string, action: "allow" | "always" | "persist" | "deny") => void;
  onOpenChild?: (id: string) => void;
  /** 已上传图片路径 → 可渲染 URL(气泡缩略图;不传则图片行按纯文本展示) */
  uploadUrl?: (path: string) => string;
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
      out.push(
        <div key={"g" + start} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {group.map((t, j) => (
            <ToolCard key={t.tcId || j} item={t} onOpenChild={onOpenChild} />
          ))}
        </div>,
      );
    } else {
      out.push(<ItemView key={i} item={it} onPermAnswer={onPermAnswer} uploadUrl={uploadUrl} />);
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

/** unified diff → 带行号的行(行号取新文件侧,删除行取旧文件侧) */
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

/** diff 面板(改动抽屉的行渲染:36px 行号列 + hunk 灰条 + 增删着色) */
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
          <div key={i} style={{ display: "flex", padding: "2px 24px", background: "var(--codeBg)", color: "var(--t4)", fontSize: 11 }}>
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
