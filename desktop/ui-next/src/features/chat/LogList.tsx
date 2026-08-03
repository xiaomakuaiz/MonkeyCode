// 消息流条目分发:按 ChatItem 判别渲染(tool/perm/ask 是 cards/ 下的正式卡)。
// 结构契约:本组件的直接子元素序列与 state.items 一一对应(不加包裹层),
// key = itemKey(state, i)——"加载更早"前插时 keyBase 左移,已渲染项不重挂载。
// 审批锚定:perm 带 toolCallId 且流里有同 id 工具卡时,按钮行嵌进那张卡
// (permAnchors),独立审批项保留占位 div 但 display:none——契约不平移。
import { Markdown } from "@/components/markdown/Markdown";
import { useI18n } from "@/lib/i18n";
import { itemKey, permAnchors } from "@/lib/protocol/reduce";
import type { ChatItem, ChatState, PermItem } from "@/lib/protocol/types";
import { AskCard } from "./cards/AskCard";
import { PermCard } from "./cards/PermCard";
import { ToolCard } from "./cards/ToolCard";

function UserBubble({ item, flash }: { item: Extract<ChatItem, { kind: "user" }>; flash?: boolean }) {
  return (
    <div
      className={`chat chat-end rounded-box ${flash ? "animate-[mc-flash_1s_ease]" : ""}`}
      data-user-seq={item.seq}
    >
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

function renderItem(item: ChatItem, sessionId: string, anchors: Map<string, PermItem>, flashSeq?: number) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} flash={item.seq !== undefined && item.seq === flashSeq} />;
    case "agent":
      return <Markdown source={item.text} />;
    case "thought":
      return <ThoughtBlock item={item} />;
    case "tool":
      return <ToolCard item={item} perm={anchors.get(item.tcId)} sessionId={sessionId} />;
    case "perm":
      return <PermCard item={item} sessionId={sessionId} />;
    case "ask":
      return <AskCard item={item} sessionId={sessionId} />;
    case "sys":
      return <div className="self-center rounded-full bg-base-200 px-3 py-0.5 text-[11px] text-base-content/50">{item.text}</div>;
  }
}

export function LogList({
  state,
  sessionId,
  flashSeq,
}: {
  state: ChatState;
  sessionId: string;
  /** 大纲跳转的目标 user seq:命中的气泡播放一次 mc-flash 闪光。 */
  flashSeq?: number;
}) {
  const anchors = permAnchors(state.items);
  // 有工具卡承接的 perm 一律不独立渲染:未决嵌进那张卡(anchors),已决由
  // 工具卡自身的 run/ok/fail 流转代言(types.ts::PermItem.toolCallId 契约)
  const toolIds = new Set<string>();
  for (const it of state.items) if (it.kind === "tool" && it.tcId) toolIds.add(it.tcId);
  return (
    <div className="flex flex-col gap-3">
      {state.items.map((item, i) =>
        item.kind === "perm" && item.toolCallId && toolIds.has(item.toolCallId) ? (
          <div key={itemKey(state, i)} className="hidden" data-perm-id={item.id} />
        ) : (
          <div key={itemKey(state, i)}>{renderItem(item, sessionId, anchors, flashSeq)}</div>
        ),
      )}
      {state.running && state.streamKind === "" && (
        <span className="loading loading-dots loading-sm text-base-content/40" aria-hidden />
      )}
    </div>
  );
}
