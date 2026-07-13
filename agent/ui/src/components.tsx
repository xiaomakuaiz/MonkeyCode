// 展示型组件:消息、工具行、计划卡、审批卡、diff 着色等。
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";
import { permStateLabel } from "./reduce";
import type { LogItem, PlanEntry, SessionMeta } from "./types";

marked.setOptions({ gfm: true, breaks: true });

/** agent 正文按 Markdown 渲染(净化后注入);流式期间随批次重渲染 */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function SessionItem({
  meta,
  active,
  onClick,
}: {
  meta: SessionMeta;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div className={"sess" + (active ? " active" : "")} onClick={onClick}>
      <div className="sess-title">{meta.title || "(未命名)"}</div>
      <div className="sess-meta">
        <span className={"dot st-" + meta.status} title={meta.status} />
        <span className="sess-dir">{meta.workdir}</span>
        <span>· {meta.turns}轮</span>
      </div>
    </div>
  );
}

function PlanCard({ entries }: { entries: PlanEntry[] }) {
  const mark = (s: string) => (s === "completed" ? "☑" : s === "in_progress" ? "◐" : "☐");
  return (
    <div className="plan">
      {entries.map((e, i) => (
        <div key={i} className={"plan-item " + e.status}>
          <span className="plan-mark">{mark(e.status)}</span> {e.content}
        </div>
      ))}
    </div>
  );
}

function statusMark(status: "run" | "ok" | "fail") {
  return status === "run" ? "◌" : status === "ok" ? "✓" : "✗";
}

function ToolLine({
  item,
  onOpenChild,
}: {
  item: Extract<LogItem, { kind: "tool" }>;
  onOpenChild?: (id: string) => void;
}) {
  return (
    <div className="tool-block">
      <div className="tool">
        <span className={"tool-dot " + item.status}>{statusMark(item.status)}</span>
        <span className="tool-name">{item.title}</span>
        {item.out && <span className="tool-out">{item.out}</span>}
        {item.childSessionId && onOpenChild && (
          <button className="link" onClick={() => onOpenChild(item.childSessionId!)}>
            查看子会话
          </button>
        )}
      </div>
      {item.subItems?.map((s) => (
        <div key={s.id} className="tool sub">
          <span className="sub-arrow">↳</span>
          <span className={"tool-dot " + s.status}>{statusMark(s.status)}</span>
          <span className="tool-out">{s.title}</span>
        </div>
      ))}
      {item.status === "run" && item.lastLine && (
        <div className="tool sub">
          <span className="sub-arrow">↳</span>
          <span className="tool-out live">{item.lastLine}</span>
        </div>
      )}
    </div>
  );
}

function PermCard({
  item,
  onAnswer,
}: {
  item: Extract<LogItem, { kind: "perm" }>;
  onAnswer: (id: string, action: "allow" | "always" | "persist" | "deny") => void;
}) {
  return (
    <div className="perm">
      <div className="perm-q">
        ⚠ 请求执行:<b>{item.title}</b> <span className="hint">({item.tool})</span>
      </div>
      {item.state === "open" ? (
        <div className="perm-btns">
          <button onClick={() => onAnswer(item.id, "allow")}>允许</button>
          <button className="ghost" onClick={() => onAnswer(item.id, "always")}>
            本会话始终
          </button>
          <button className="ghost" onClick={() => onAnswer(item.id, "persist")}>
            此项目永久
          </button>
          <button className="danger" onClick={() => onAnswer(item.id, "deny")}>
            拒绝
          </button>
        </div>
      ) : (
        <div className="hint">{permStateLabel(item.state)}</div>
      )}
    </div>
  );
}

export function LogItemView({
  item,
  onPermAnswer,
  onOpenChild,
}: {
  item: LogItem;
  onPermAnswer: (id: string, action: "allow" | "always" | "persist" | "deny") => void;
  onOpenChild?: (id: string) => void;
}) {
  switch (item.kind) {
    case "user":
      return <div className="msg user">{item.text}</div>;
    case "agent":
      return (
        <div className="msg agent">
          <Markdown text={item.text} />
        </div>
      );
    case "thought":
      return <div className="msg thought">{item.text}</div>;
    case "tool":
      return <ToolLine item={item} onOpenChild={onOpenChild} />;
    case "plan":
      return <PlanCard entries={item.entries} />;
    case "sys":
      return <div className={"sysline" + (item.error ? " err" : "")}>{item.text}</div>;
    case "perm":
      return <PermCard item={item} onAnswer={onPermAnswer} />;
  }
}

/** unified diff 按行着色 */
export function DiffView({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="diff">
      {lines.map((line, i) => {
        let cls = "";
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
          cls = "diff-meta";
        else if (line.startsWith("@@")) cls = "diff-hunk";
        else if (line.startsWith("+")) cls = "diff-add";
        else if (line.startsWith("-")) cls = "diff-del";
        return (
          <span key={i} className={cls}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}
