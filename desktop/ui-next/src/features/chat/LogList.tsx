// 消息流条目分发:按 ChatItem 判别渲染(tool/perm/ask 是 cards/ 下的正式卡)。
// 结构契约:本组件的直接子元素序列与 state.items 一一对应(不加包裹层),
// key = itemKey(state, i)——"加载更早"前插时 keyBase 左移,已渲染项不重挂载。
// 审批锚定:perm 带 toolCallId 且流里有同 id 工具卡时,按钮行嵌进那张卡
// (permAnchors),独立审批项保留占位 div 但 display:none——契约不平移。
import { File as FileIcon, Sparkles } from "lucide-react";
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

/** 消息时间:恒占位的行内 <time>,悬停所在消息块(group)时以透明度显影。
 * §6.2 hover 显隐铁律:元素常驻布局只切可见性,悬停不挤动周围内容
 * (旧 UI 的绝对定位浮标降级为行内呈现)。缺时间戳/坏值不渲染。 */
function MessageTime({ timestamp, className = "" }: { timestamp?: number; className?: string }) {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
      className={`text-[10px] text-base-content/40 opacity-0 transition-opacity select-none group-hover:opacity-100 ${className}`}
    >
      {hhmm}
    </time>
  );
}

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
      <MessageTime timestamp={item.timestamp} className="chat-footer" />
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
    // 思考块走官方 collapse 形态;弱化收尾交给主题变量,不在组件上叠覆写
    <details className="collapse-arrow collapse border border-base-300 bg-base-200">
      <summary className="collapse-title min-h-0 py-2 text-xs text-base-content/60">
        <Sparkles size={12} strokeWidth={1.75} aria-hidden className="me-1.5 inline-block align-[-1px]" />
        {t("chat.thought")}
        <span className="ml-2 opacity-70">{summary.slice(0, 80)}</span>
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
}

function renderItem(item: ChatItem, o: RenderOpts) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} flash={item.seq !== undefined && item.seq === o.flashSeq} uploadUrl={o.uploadUrl} />;
    case "agent":
      // group 包裹:行内 <time> 悬停显影(恒占位只切透明度,见 MessageTime)
      return (
        <div className="group flex flex-col">
          <Markdown source={item.text} localImageUrl={o.uploadUrl} onLocalLink={o.onLocalLink} />
          <MessageTime timestamp={item.timestamp} className="self-start" />
        </div>
      );
    case "thought":
      return <ThoughtBlock item={item} />;
    case "tool":
      // 只读回放不递交锚定审批:工具卡不出内嵌按钮行,按 run/ok/fail 常态渲染
      return (
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
        />
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
        // 连续模型切换属于一件系统事件:相邻同 tag 只渲最后一条(reduce 的
        // 文案已是终值「模型已切换为 X」);被合并行保占位,结构契约不平移
        const next = state.items[i + 1];
        if (item.kind === "sys" && item.tag === "model" && next?.kind === "sys" && next.tag === "model") {
          return <div key={itemKey(state, i)} className="hidden" aria-hidden />;
        }
        const compact = prevVisible !== null && prevVisible.kind === "tool" && item.kind === "tool";
        const gapClass = prevVisible === null ? "" : compact ? " mt-1.5" : " mt-4";
        prevVisible = item;
        return (
          // 包裹 div 自身是 flex 列:系统行等条目的 self-center 才有对齐上下文
          // (包裹层是块级时 align-self 无效,居中丢失)
          <div key={itemKey(state, i)} className={`flex flex-col${gapClass}`}>
            {renderItem(item, { sessionId, anchors, flashSeq, sendFrame, readonly, onOpenChildSession, uploadUrl, onLocalLink, workdir, loadFullTool })}
          </div>
        );
      })}
      {state.running && state.streamKind === "" && (
        <span className="loading loading-dots loading-sm mt-3 text-base-content/40" aria-hidden />
      )}
    </div>
  );
}
