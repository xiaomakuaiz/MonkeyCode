// 消息流条目分发:按 ChatItem 判别渲染。P3b 覆盖 user/agent/thought/sys,
// tool/perm/ask 先给可辨认的极简卡(P3c 换正式卡)。
// 结构契约:本组件的直接子元素序列与 state.items 一一对应(不加包裹层),
// key = itemKey(state, i)——"加载更早"前插时 keyBase 左移,已渲染项不重挂载。
import { Markdown } from "@/components/markdown/Markdown";
import { useI18n } from "@/lib/i18n";
import { itemKey, permStateLabel } from "@/lib/protocol/reduce";
import type { ChatItem, ChatState } from "@/lib/protocol/types";

function UserBubble({ item }: { item: Extract<ChatItem, { kind: "user" }> }) {
  return (
    <div className="chat chat-end" data-user-seq={item.seq}>
      <div className="chat-bubble chat-bubble-primary max-w-[85%] text-sm whitespace-pre-wrap select-text">
        {item.text}
        {item.attachments?.map((a) => (
          <a key={a.url} href={a.url} className="link mt-1 block text-xs opacity-80">
            {a.filename}
          </a>
        ))}
      </div>
    </div>
  );
}

function ThoughtBlock({ item }: { item: Extract<ChatItem, { kind: "thought" }> }) {
  const { t } = useI18n();
  const summary = item.text.split("\n").find((l) => l.trim()) ?? "";
  return (
    <details className="collapse-arrow collapse rounded-box border border-base-300 bg-base-200/50">
      <summary className="collapse-title min-h-0 py-2 text-xs text-base-content/60">
        <span aria-hidden>✦ </span>
        {t("chat.thought")}
        <span className="ml-2 opacity-70">{summary.slice(0, 80)}</span>
      </summary>
      <div className="collapse-content border-s-2 border-base-300 text-xs">
        <Markdown source={item.text} className="opacity-80" />
      </div>
    </details>
  );
}

function ToolStub({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const tone = item.status === "fail" ? "status-error" : item.status === "run" ? "status-primary animate-pulse" : "status-success";
  return (
    <div className="card card-border border-base-300 bg-base-100" data-tool-id={item.tcId}>
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <span aria-hidden className={`status ${tone}`} />
        <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
        {item.durationMs !== undefined && (
          <span className="font-mono text-base-content/40 tabular-nums">{(item.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
    </div>
  );
}

function PermStub({ item }: { item: Extract<ChatItem, { kind: "perm" }> }) {
  const { t } = useI18n();
  return (
    <div role="status" className="alert alert-warning alert-soft py-1.5 text-xs" data-perm-id={item.id}>
      <span className="min-w-0 flex-1 truncate">
        {t("chat.permission")}:{item.title}
      </span>
      <span className="badge badge-ghost badge-xs">{permStateLabel(item.state)}</span>
    </div>
  );
}

function AskStub({ item }: { item: Extract<ChatItem, { kind: "ask" }> }) {
  const { t } = useI18n();
  return (
    <div role="status" className="alert alert-info alert-soft py-1.5 text-xs">
      <span className="min-w-0 flex-1 truncate">{t("chat.question")}</span>
      <span className="badge badge-ghost badge-xs">{item.state}</span>
    </div>
  );
}

function renderItem(item: ChatItem) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} />;
    case "agent":
      return <Markdown source={item.text} />;
    case "thought":
      return <ThoughtBlock item={item} />;
    case "tool":
      return <ToolStub item={item} />;
    case "perm":
      return <PermStub item={item} />;
    case "ask":
      return <AskStub item={item} />;
    case "sys":
      return <div className="self-center rounded-full bg-base-200 px-3 py-0.5 text-[11px] text-base-content/50">{item.text}</div>;
  }
}

export function LogList({ state }: { state: ChatState }) {
  return (
    <div className="flex flex-col gap-3">
      {state.items.map((item, i) => (
        <div key={itemKey(state, i)}>{renderItem(item)}</div>
      ))}
      {state.running && state.streamKind === "" && (
        <span className="loading loading-dots loading-sm text-base-content/40" aria-hidden />
      )}
    </div>
  );
}
