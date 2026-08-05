// 消息流条目分发:按 ChatItem 判别渲染(tool/perm/ask 是 cards/ 下的正式卡)。
// 结构契约:本组件的直接子元素序列与 state.items 一一对应(不加包裹层),
// key = itemKey(state, i)——"加载更早"前插时 keyBase 左移,已渲染项不重挂载。
// 审批锚定:perm 带 toolCallId 且流里有同 id 工具卡时,按钮行嵌进那张卡
// (permAnchors),独立审批项保留占位 div 但 display:none——契约不平移。
import { ChevronRight, File as FileIcon, Sparkles } from "lucide-react";
import { useState } from "react";

import { Markdown } from "@/components/markdown/Markdown";
import { downloadUpload, Lightbox, UploadImg } from "@/components/media/UploadImg";
import { useI18n } from "@/lib/i18n";
import type { FrameSender } from "@/lib/ipc/approvals";
import { openExternal } from "@/lib/ipc/host";
import { isImagePath } from "@/lib/ipc/uploads";
import { splitAttachments } from "@/lib/protocol/attLine";
import { itemKey, permAnchors } from "@/lib/protocol/reduce";
import type { ChatItem, ChatState, Frame, PermItem } from "@/lib/protocol/types";
import { thoughtMarkdown } from "@/lib/util/thoughtMarkdown";
import { AskCard } from "./cards/AskCard";
import { PermCard } from "./cards/PermCard";
import { ToolCard } from "./cards/ToolCard";
import { MessageTime } from "./MessageTime";

/** 用户气泡:正文 + 附件呈现(旧 UI logView 的信息布局)。附件两个来源互斥:
 * 本地会话走正文附件行约定(uploadUrl 回读工作区,点图看大图/点文件下载),
 * 云端任务走 attachments 字段(对象存储直链;文件 chip 点击在浏览器打开)。
 * 附件行只在有回读通道时剥离——无通道剥了就没法呈现,正文原样兜底。 */
function UserBubble({
  item,
  flash,
  uploadUrl,
}: {
  item: Extract<ChatItem, { kind: "user" }>;
  flash?: boolean;
  uploadUrl?: (path: string) => Promise<string>;
}) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState<string | null>(null); // 本地图:工作区相对路径
  const [zoomUrl, setZoomUrl] = useState<string | null>(null); // 云端图:直链
  const { body, images, files } = uploadUrl
    ? splitAttachments(item.text)
    : { body: item.text, images: [] as string[], files: [] as string[] };
  const atts = item.attachments ?? [];
  const cloudImages = atts.filter((a) => isImagePath(a.filename));
  const cloudFiles = atts.filter((a) => !isImagePath(a.filename));
  const hasAtts = images.length + files.length + cloudImages.length + cloudFiles.length > 0;
  const thumb = "block max-h-28 max-w-36 cursor-zoom-in rounded-box";
  return (
    <div
      className={`group chat chat-end rounded-box ${flash ? "animate-[mc-flash_1s_ease]" : ""}`}
      data-user-seq={item.seq}
    >
      {/* 时间在块顶(chat-header 官方槽):块可能很长,沉底会看不见 */}
      <MessageTime timestamp={item.timestamp} className="chat-header" />
      <div className="chat-bubble max-w-[85%] text-sm whitespace-pre-wrap select-text">
        {body}
        {hasAtts && (
          <div className={`flex flex-wrap items-center gap-1.5 ${body ? "mt-2" : ""}`}>
            {cloudImages.map((a) => (
              <img key={a.url} src={a.url} alt={a.filename} title={a.filename} className={thumb} onClick={() => setZoomUrl(a.url)} />
            ))}
            {cloudFiles.map((a) => (
              <button
                key={a.url}
                type="button"
                className="btn btn-ghost btn-xs max-w-56"
                title={t("chat.att.openTip", { name: a.filename })}
                onClick={() => openExternal(a.url)}
              >
                <FileIcon size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
                <span className="min-w-0 truncate">{a.filename}</span>
              </button>
            ))}
            {images.map((p) => (
              <UploadImg key={p} load={() => uploadUrl!(p)} alt={p} title={p} className={thumb} onClick={() => setZoom(p)} />
            ))}
            {files.map((p) => (
              <button
                key={p}
                type="button"
                className="btn btn-ghost btn-xs max-w-56"
                title={t("chat.att.downloadTip", { name: p })}
                onClick={() => downloadUpload(() => uploadUrl!(p), p.split("/").pop() || p)}
              >
                <FileIcon size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
                <span className="min-w-0 truncate">{p.split("/").pop() || p}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {zoom && uploadUrl && (
        <Lightbox alt={zoom} onClose={() => setZoom(null)}>
          <UploadImg load={() => uploadUrl(zoom)} alt={zoom} className="max-h-[84vh] max-w-full" />
        </Lightbox>
      )}
      {zoomUrl && (
        <Lightbox alt={zoomUrl} onClose={() => setZoomUrl(null)}>
          <img src={zoomUrl} alt={zoomUrl} className="max-h-[84vh] max-w-full" />
        </Lightbox>
      )}
    </div>
  );
}

function ThoughtBlock({ item }: { item: Extract<ChatItem, { kind: "thought" }> }) {
  const { t } = useI18n();
  // 正文过 thoughtMarkdown:流式裸拼的相邻加粗标题(****)先补成段落边界
  const md = thoughtMarkdown(item.text);
  const summary = md.split("\n").find((l) => l.trim()) ?? "";
  return (
    // 思考块走官方 collapse 形态(native details);展开指示与工具卡统一为
    // 行尾 ChevronRight(open 态转 90°,弃 collapse-arrow 的另一套箭头语言,
    // 用户定案 2026-08-05);时间与其他块一致 hover 显影(group 在 details 上)
    <details className="group collapse border border-base-300 bg-base-200">
      <summary className="collapse-title flex min-h-0 items-center gap-1.5 py-2 pe-3 text-xs text-base-content/60">
        <Sparkles size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
        <span className="shrink-0">{t("chat.thought")}</span>
        <span className="min-w-0 flex-1 truncate opacity-70">{summary.slice(0, 80)}</span>
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          aria-hidden
          className="shrink-0 text-base-content/40 transition-transform group-open:rotate-90"
        />
      </summary>
      <div className="collapse-content border-s-2 border-base-300 text-xs">
        <Markdown source={md} className="opacity-80" />
      </div>
    </details>
  );
}

interface RenderOpts {
  sessionId: string;
  anchors: Map<string, PermItem>;
  flashSeq?: number;
  sendFrame?: FrameSender;
  readonly?: boolean;
  onOpenChildSession?: (id: string) => void;
  uploadUrl?: (path: string) => Promise<string>;
  onLocalLink?: (path: string) => void;
  workdir?: string;
  loadFullTool?: (seq: number) => Promise<Frame>;
  /** 相邻工具卡共享外框(旧 tool-stack;LogList 按可见邻居计算)。 */
  joinPrev?: boolean;
  joinNext?: boolean;
}

function renderItem(item: ChatItem, o: RenderOpts) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} flash={item.seq !== undefined && item.seq === o.flashSeq} uploadUrl={o.uploadUrl} />;
    case "agent":
      // 时间在块顶悬停显影:正文可能很长,沉底看不见(用户定案 2026-08-05)
      return (
        <div className="group flex flex-col">
          <MessageTime timestamp={item.timestamp} className="self-start" />
          <Markdown source={item.text} localImageUrl={o.uploadUrl} onLocalLink={o.onLocalLink} />
        </div>
      );
    case "thought":
      // 与助手块同构:时间线在块上方(悬停块内即显影)
      return (
        <div className="group flex flex-col">
          <MessageTime timestamp={item.timestamp} className="self-start" />
          <ThoughtBlock item={item} />
        </div>
      );
    case "tool":
      // 只读回放不递交锚定审批:工具卡不出内嵌按钮行,按 run/ok/fail 常态渲染。
      // 时间线只在组首(非 joinPrev)卡上方——组中插时间行会撕开共享外框
      return (
        <div className="group flex flex-col">
          {!o.joinPrev && <MessageTime timestamp={item.timestamp} className="self-start" />}
          <ToolCard
            item={item}
            perm={o.readonly ? undefined : o.anchors.get(item.tcId)}
            sessionId={o.sessionId}
            sendFrame={o.sendFrame}
            onOpenChild={o.onOpenChildSession}
            uploadUrl={o.uploadUrl}
            onLocalLink={o.onLocalLink}
            workdir={o.workdir}
            loadFullTool={o.loadFullTool}
            joinPrev={o.joinPrev}
            joinNext={o.joinNext}
          />
        </div>
      );
    case "perm":
      return <PermCard item={item} sessionId={o.sessionId} sendFrame={o.sendFrame} readonly={o.readonly} />;
    case "ask":
      return <AskCard item={item} sessionId={o.sessionId} sendFrame={o.sendFrame} readonly={o.readonly} />;
    case "sys":
      // turn-end 收敛为 2px 呼吸位:消息天然按用户/助手交替,不再用文字
      // 切碎正文;全文留在 title 供悬停查证(旧 UI TurnDivider 同语义)
      if (item.tag === "turn-end") return <div aria-hidden title={item.text} className="h-0.5" />;
      return (
        <div
          className={`badge badge-ghost badge-sm self-center ${item.error ? "text-error" : "text-base-content/40"}`}
        >
          {item.text}
        </div>
      );
  }
}

export function LogList({
  state,
  sessionId,
  flashSeq,
  sendFrame,
  readonly,
  onOpenChildSession,
  uploadUrl,
  onLocalLink,
  workdir,
  loadFullTool,
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
  /** 本地附件回读通道(路径 → data URL);缺省 = 不剥附件行、正文原样。 */
  uploadUrl?: (path: string) => Promise<string>;
  /** markdown 工作区文件链接点击代理(reveal);缺省点击无动作。 */
  onLocalLink?: (path: string) => void;
  /** 会话工作目录:工具卡 path 型目标剥绝对前缀;缺省不剥。 */
  workdir?: string;
  /** 工具卡大字段回读通道(按帧 seq 取原帧);缺省只展示截断头部。 */
  loadFullTool?: (seq: number) => Promise<Frame>;
}) {
  const { t } = useI18n();
  // 长工具组折叠的展开记录(键 = 组首条目的 itemKey,keyBase 感知,前插
  // 不漂移);仅内存,切会话重挂即复位
  const [expandedStacks, setExpandedStacks] = useState<Set<number>>(new Set());
  const anchors = permAnchors(state.items);
  // 有工具卡承接的 perm 一律不独立渲染:未决嵌进那张卡(anchors),已决由
  // 工具卡自身的 run/ok/fail 流转代言(types.ts::PermItem.toolCallId 契约)
  const toolIds = new Set<string>();
  for (const it of state.items) if (it.kind === "tool" && it.tcId) toolIds.add(it.tcId);
  const isHidden = (it: ChatItem) => it.kind === "perm" && !!it.toolCallId && toolIds.has(it.toolCallId);
  // 被合并的连续模型行(相邻同 tag 只渲最后一条,reduce 文案已是终值)
  const mergedModelAt = (i: number) => {
    const it = state.items[i];
    const nx = state.items[i + 1];
    return it?.kind === "sys" && it.tag === "model" && nx?.kind === "sys" && nx.tag === "model";
  };
  const hiddenAt = (i: number) => isHidden(state.items[i]!) || mergedModelAt(i);
  // 相邻工具卡共享外框(旧 tool-stack):joinNext 要越过隐藏占位看下一个
  // 可见条目;DOM 仍与 items 一一对应,合并靠边框塌陷不加包裹层
  const nextVisibleIsTool = (i: number) => {
    for (let j = i + 1; j < state.items.length; j++) {
      if (hiddenAt(j)) continue;
      return state.items[j]!.kind === "tool";
    }
    return false;
  };
  // 长工具组折叠(用户反馈 2026-08-05:连续调用组太长):同组可见工具卡
  // ≥ FOLD_MIN 时默认只显首 FOLD_HEAD + 尾 FOLD_TAIL,中段收进「展开其余
  // N 步」行;被折卡保 hidden 占位,DOM 仍与 items 一一对应。运行中新卡
  // 追加在尾部,可见尾窗自然跟进
  const FOLD_MIN = 6;
  const FOLD_HEAD = 1;
  const FOLD_TAIL = 3;
  const stackInfo = new Map<number, { start: number; len: number; pos: number }>();
  {
    let members: number[] = [];
    const flush = () => {
      const start = members[0];
      if (start !== undefined) members.forEach((idx, pos) => stackInfo.set(idx, { start, len: members.length, pos }));
      members = [];
    };
    state.items.forEach((it, i) => {
      if (hiddenAt(i)) return; // 隐藏占位不断组
      if (it.kind === "tool") members.push(i);
      else flush();
    });
    flush();
  }

  // 条目节奏:消息块之间放宽(16px);组内工具卡零距(共享外框)。以包裹层
  // margin 实现(隐藏占位 display:none 不吃 margin)——结构契约不变
  let prevVisible: ChatItem | null = null;
  return (
    <div className="flex flex-col">
      {state.items.map((item, i) => {
        if (isHidden(item) && item.kind === "perm") {
          return <div key={itemKey(state, i)} className="hidden" data-perm-id={item.id} />;
        }
        if (mergedModelAt(i)) {
          return <div key={itemKey(state, i)} className="hidden" aria-hidden />;
        }
        const joinPrev = item.kind === "tool" && prevVisible?.kind === "tool";
        const joinNext = item.kind === "tool" && nextVisibleIsTool(i);
        const gapClass = prevVisible === null || joinPrev ? "" : " mt-4";
        prevVisible = item;

        // 折叠中段:首个被折位渲染展开行(占该条目的包裹位),其余保占位
        const stack = item.kind === "tool" ? stackInfo.get(i) : undefined;
        if (stack && stack.len >= FOLD_MIN) {
          const stackKey = itemKey(state, stack.start);
          const folded = !expandedStacks.has(stackKey) && stack.pos >= FOLD_HEAD && stack.pos < stack.len - FOLD_TAIL;
          if (folded) {
            if (stack.pos !== FOLD_HEAD) return <div key={itemKey(state, i)} className="hidden" aria-hidden />;
            const count = stack.len - FOLD_HEAD - FOLD_TAIL;
            return (
              <div key={itemKey(state, i)} className="flex flex-col">
                <button
                  type="button"
                  className="flex cursor-pointer items-center justify-center gap-1 border-x border-t border-base-300 bg-base-100 px-3 py-1 text-[11px] text-base-content/50"
                  onClick={() => setExpandedStacks((prev) => new Set(prev).add(stackKey))}
                >
                  <ChevronRight size={10} strokeWidth={1.75} aria-hidden className="rotate-90" />
                  {t("chat.tool.foldExpand", { count })}
                </button>
              </div>
            );
          }
        }
        return (
          // 包裹 div 自身是 flex 列:系统行等条目的 self-center 才有对齐上下文
          // (包裹层是块级时 align-self 无效,居中丢失)
          <div key={itemKey(state, i)} className={`flex flex-col${gapClass}`}>
            {renderItem(item, { sessionId, anchors, flashSeq, sendFrame, readonly, onOpenChildSession, uploadUrl, onLocalLink, workdir, loadFullTool, joinPrev, joinNext })}
          </div>
        );
      })}
      {state.running && state.streamKind === "" && (
        <span className="loading loading-dots loading-sm mt-3 text-base-content/40" aria-hidden />
      )}
    </div>
  );
}
