// 消息流条目分发:按 ChatItem 判别渲染(tool/perm/ask 是 cards/ 下的正式卡)。
// 结构契约:本组件的直接子元素序列与 state.items 一一对应(不加包裹层),
// key = itemKey(state, i)——"加载更早"前插时 keyBase 左移,已渲染项不重挂载。
// 审批锚定:perm 带 toolCallId 且流里有同 id 工具卡时,按钮行嵌进那张卡
// (permAnchors),独立审批项保留占位 div 但 display:none——契约不平移。
import { Sparkles } from "lucide-react";

import { Markdown } from "@/components/markdown/Markdown";
import { useI18n } from "@/lib/i18n";
import type { FrameSender } from "@/lib/ipc/approvals";
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
    // 思考块刻意弱化:虚线边 + 半透明面,视觉上退到消息流之后
    <details className="collapse-arrow collapse rounded-box border border-dashed border-base-300 bg-base-200/50">
      <summary className="collapse-title min-h-0 py-2 text-xs text-base-content/60">
        <Sparkles size={12} strokeWidth={1.75} aria-hidden className="me-1.5 inline-block align-[-1px]" />
        {t("chat.thought")}
        <span className="ml-2 opacity-70">{summary.slice(0, 80)}</span>
      </summary>
      <div className="collapse-content border-s-2 border-base-300 text-xs">
        <Markdown source={item.text} className="opacity-80" />
      </div>
    </details>
  );
}

function renderItem(
  item: ChatItem,
  sessionId: string,
  anchors: Map<string, PermItem>,
  flashSeq?: number,
  sendFrame?: FrameSender,
  readonly?: boolean,
  onOpenChildSession?: (id: string) => void,
) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} flash={item.seq !== undefined && item.seq === flashSeq} />;
    case "agent":
      return <Markdown source={item.text} />;
    case "thought":
      return <ThoughtBlock item={item} />;
    case "tool":
      // 只读回放不递交锚定审批:工具卡不出内嵌按钮行,按 run/ok/fail 常态渲染
      return (
        <ToolCard
          item={item}
          perm={readonly ? undefined : anchors.get(item.tcId)}
          sessionId={sessionId}
          sendFrame={sendFrame}
          onOpenChild={onOpenChildSession}
        />
      );
    case "perm":
      return <PermCard item={item} sessionId={sessionId} sendFrame={sendFrame} readonly={readonly} />;
    case "ask":
      return <AskCard item={item} sessionId={sessionId} sendFrame={sendFrame} readonly={readonly} />;
    case "sys":
      return <div className="badge badge-ghost h-auto self-center px-3 py-0.5 text-[11px] text-base-content/50">{item.text}</div>;
  }
}

export function LogList({
  state,
  sessionId,
  flashSeq,
  sendFrame,
  readonly,
  onOpenChildSession,
}: {
  state: ChatState;
  sessionId: string;
  /** 大纲跳转的目标 user seq:命中的气泡播放一次 mc-flash 闪光。 */
  flashSeq?: number;
  /** 审批/提问答复的上行管道注入(云端任务经 stream WS 发帧);
   * 缺省 = sessionId 的本地 sender(壳侧 session_send)。 */
  sendFrame?: FrameSender;
  /** 只读回放(子代理会话浮层):审批/提问卡按已决/禁用渲染,不出交互按钮。 */
  readonly?: boolean;
  /** 子代理工具卡「查看子会话」入口(缺省不渲染入口)。 */
  onOpenChildSession?: (id: string) => void;
}) {
  const anchors = permAnchors(state.items);
  // 有工具卡承接的 perm 一律不独立渲染:未决嵌进那张卡(anchors),已决由
  // 工具卡自身的 run/ok/fail 流转代言(types.ts::PermItem.toolCallId 契约)
  const toolIds = new Set<string>();
  for (const it of state.items) if (it.kind === "tool" && it.tcId) toolIds.add(it.tcId);
  const isHidden = (it: ChatItem) => it.kind === "perm" && !!it.toolCallId && toolIds.has(it.toolCallId);
  // 条目节奏差:相邻工具卡收紧(6px),消息块之间放宽(16px)。以包裹层
  // margin 实现(隐藏占位 display:none 不吃 margin),直接子元素仍与
  // items 一一对应——结构契约不变
  let prevVisible: ChatItem | null = null;
  return (
    <div className="flex flex-col">
      {state.items.map((item, i) => {
        if (isHidden(item) && item.kind === "perm") {
          return <div key={itemKey(state, i)} className="hidden" data-perm-id={item.id} />;
        }
        const compact = prevVisible !== null && prevVisible.kind === "tool" && item.kind === "tool";
        const gapClass = prevVisible === null ? "" : compact ? " mt-1.5" : " mt-4";
        prevVisible = item;
        return (
          // 包裹 div 自身是 flex 列:系统行等条目的 self-center 才有对齐上下文
          // (包裹层是块级时 align-self 无效,居中丢失)
          <div key={itemKey(state, i)} className={`flex flex-col${gapClass}`}>
            {renderItem(item, sessionId, anchors, flashSeq, sendFrame, readonly, onOpenChildSession)}
          </div>
        );
      })}
      {state.running && state.streamKind === "" && (
        <span className="loading loading-dots loading-sm mt-3 text-base-content/40" aria-hidden />
      )}
    </div>
  );
}
