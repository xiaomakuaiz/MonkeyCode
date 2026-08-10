// 消息流条目分发:按 ChatItem 判别渲染(tool/perm/ask 是 cards/ 下的正式卡)。
// 结构契约:本组件的直接子元素序列与 state.items 一一对应(不加包裹层),
// key = itemKey(state, i)——"加载更早"前插时 keyBase 左移,已渲染项不重挂载。
// 审批锚定:perm 带 toolCallId 且流里有同 id 工具卡时,按钮行嵌进那张卡
// (permAnchors),独立审批项保留占位 div 但 display:none——契约不平移。
import { IconChevronRight, IconFile as FileIcon, IconSparkles } from "@tabler/icons-react";
import { memo, useState } from "react";

import { Markdown, MarkdownInline } from "@/components/markdown/Markdown";
import { downloadUpload, Lightbox, UploadImg } from "@/components/media/UploadImg";
import { useI18n } from "@/lib/i18n";
import type { FrameSender } from "@/lib/ipc/approvals";
import { openExternal } from "@/lib/ipc/host";
import { isImagePath } from "@/lib/ipc/uploads";
import { splitAttachments } from "@/lib/protocol/attLine";
import { itemKey, permAnchors, THINK_KEY } from "@/lib/protocol/reduce";
import type { ChatItem, ChatState, Frame, PermItem } from "@/lib/protocol/types";
import { presentToolCall } from "@/lib/tools/toolLabels";
import { thoughtMarkdown, thoughtSummary } from "@/lib/util/thoughtMarkdown";
import { AskCard } from "./cards/AskCard";
import { PermCard } from "./cards/PermCard";
import { statusDot } from "./cards/statusDot";
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
  // 归约层对缺名附件留空串(不产成品文案),展示名在这儿兜底
  const attName = (a: { filename: string }) => a.filename || t("common.unnamedFile");
  const atts = item.attachments ?? [];
  const cloudImages = atts.filter((a) => isImagePath(a.filename));
  const cloudFiles = atts.filter((a) => !isImagePath(a.filename));
  const hasAtts = images.length + files.length + cloudImages.length + cloudFiles.length > 0;
  const thumb = "block max-h-28 max-w-36 cursor-zoom-in rounded-box";
  return (
    <div
      className={`group chat chat-end relative rounded-box ${flash ? "animate-[mc-flash_1s_ease]" : ""}`}
      data-user-seq={item.seq}
    >
      {/* 时间绝对定位在块顶空隙里(§6.2 允许的另一形态):不占流式高度,
          消息节奏不因时间线变松 */}
      <MessageTime timestamp={item.timestamp} className="absolute -top-3.5 end-1" />
      {/* 用户消息 = primary 淡染(10%,与菜单选中态同语言):实色 primary 太
          鲜艳(用户报障 2026-08-06),默认 base-300 又太淡,取中间档;文字保持
          正文色。wrap-anywhere:长串无空格内容(URL/路径/token)必须可断,
          否则从气泡右缘溢出(bubble 尾巴 background inherit,淡染一体生效) */}
      <div className="chat-bubble max-w-[85%] bg-primary/10 text-sm whitespace-pre-wrap wrap-anywhere select-text">
        {body}
        {hasAtts && (
          <div className={`flex flex-wrap items-center gap-1.5 ${body ? "mt-2" : ""}`}>
            {cloudImages.map((a) => (
              <img key={a.url} src={a.url} alt={attName(a)} title={attName(a)} className={thumb} onClick={() => setZoomUrl(a.url)} />
            ))}
            {cloudFiles.map((a) => (
              <button
                key={a.url}
                type="button"
                className="btn btn-ghost btn-xs max-w-56"
                title={t("chat.att.openTip", { name: attName(a) })}
                onClick={() => openExternal(a.url)}
              >
                <FileIcon size={12} stroke={1.75} aria-hidden className="shrink-0" />
                <span className="min-w-0 truncate">{attName(a)}</span>
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
                <FileIcon size={12} stroke={1.75} aria-hidden className="shrink-0" />
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
  const summary = thoughtSummary(md);
  return (
    // 思考块走官方 collapse 形态(native details);展开指示与工具卡统一为
    // 行尾 ChevronRight(open 态转 90°,弃 collapse-arrow 的另一套箭头语言,
    // 用户定案 2026-08-05);时间与其他块一致 hover 显影(group 在 details 上)
    <details className="group collapse border border-base-300 bg-base-200">
      {/* ps-2.5 是对齐算出来的,不是随手取的:daisyUI .collapse-title 自带
          padding:1rem,只覆 py/pe 会留下 16px 的左内距,而工具卡/组头是 px-3
          (12px)+ 8px 状态点 → 点心在 16px。这里 12px 的 IconSparkles 要让图标中心
          也落 16px,左内距得是 16-6=10px;文字起点随之 10+12+gap-1.5 = 28px,
          与工具行的 12+8+gap-2 = 28px 齐平(用户报障 2026-08-06:两种行首图标错位) */}
      <summary className="collapse-title flex min-h-0 items-center gap-1.5 py-2 ps-2.5 pe-3 text-xs text-base-content/60">
        <IconSparkles size={12} stroke={1.75} aria-hidden className="shrink-0" />
        <span className="shrink-0">{t("chat.thought")}</span>
        {/* 摘要行走 MarkdownInline(与 FindingsCard 的发现标题同件):引擎的
            思考首行几乎都是 `**小标题**`,当纯文本贴出来就是满屏字面量星号 */}
        <MarkdownInline source={summary} className="min-w-0 flex-1 truncate opacity-70" />
        <IconChevronRight
          size={12}
          stroke={1.75}
          aria-hidden
          className="shrink-0 text-base-content/40 transition-transform group-open:rotate-90"
        />
      </summary>
      {/* 结构线走**内嵌**引用条(与 ToolCard 子代理结果同形态:border-s-2 + ps-3),
          不能挂在 collapse-content 自身:那层与卡片边缘齐平,而 daisyUI .collapse
          有 border-radius 却无 overflow 裁剪,大圆角主题(--radius-box 1rem+)下
          这条直线会戳出卡片左下的圆角轮廓,看着像块碎片。靠 collapse-content
          自带的 1rem 内距把条子推进卡内,任何圆角口径都不碰边。 */}
      <div className="collapse-content text-xs">
        <div className="border-s-2 border-base-300 ps-3">
          <Markdown source={md} className="opacity-80" />
        </div>
      </div>
    </details>
  );
}

type T = ReturnType<typeof useI18n>["t"];

interface RenderOpts {
  sessionId: string;
  /** 归约层只给 i18n 键,系统行文案在渲染时求值(见 sysText) */
  t: T;
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
      // 时间绝对定位在块顶空隙(悬停显影,不占流式高度)
      return (
        <div className="group relative flex flex-col">
          <MessageTime timestamp={item.timestamp} className="absolute -top-3.5 start-0" />
          <Markdown source={item.text} localImageUrl={o.uploadUrl} onLocalLink={o.onLocalLink} />
        </div>
      );
    case "thought":
      // 与助手块同构:时间线在块顶空隙
      return (
        <div className="group relative flex flex-col">
          <MessageTime timestamp={item.timestamp} className="absolute -top-3.5 start-0" />
          <ThoughtBlock item={item} />
        </div>
      );
    case "tool":
      // 只读回放不递交锚定审批:工具卡不出内嵌按钮行,按 run/ok/fail 常态渲染。
      // 时间线只在组首(非 joinPrev)卡顶空隙——组中插时间行会撕开共享外框
      return (
        <div className="group relative flex flex-col">
          {!o.joinPrev && <MessageTime timestamp={item.timestamp} className="absolute -top-3.5 start-0" />}
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
      if (item.tag === "turn-end") return <div aria-hidden title={sysText(item, o.t)} className="h-0.5" />;
      // h-auto/py/whitespace-normal 不可省:daisyUI 的 .badge 是
      // `height: var(--size)` **写死**(badge-sm = 20px),且不带 white-space
      // 也不裁切。系统行的文案长度不受控——reduce.ts 把引擎/RPC 的原始错误串、
      // 子代理 task_notification 的整句 description 原样灌进来,760px 列宽下
      // 62 个汉字就折行,折行后内容高度超出那 20px,再以 align-items:center
      // 上下对称溢出:药丸底色只盖住中间一条带,文字从上下缘探出去,看着像
      // 渲染坏了,超长时还压到相邻消息块。
      // select-text:错误文案要能复制走(body 级 user-select:none 之下,
      // 这一支祖先链上没有任何放开点;旧 UI 的白名单点名了「系统行」)。
      return (
        <div
          className={`badge badge-ghost badge-sm h-auto max-w-full self-center py-0.5 whitespace-normal select-text ${
            item.error ? "text-error" : "text-base-content/40"
          }`}
        >
          {sysText(item, o.t)}
        </div>
      );
  }
}

/** 系统行文案:归约层只给 key(+原始参数),这里按当前 locale 求值。
 *  key 缺席 = 上游自由文本(notify 通知正文),原样渲染。
 *  think 单列一条:params 里存的是**原始档位**(low/high…),要再过一次
 *  THINK_KEY 才拿得到当前语言的档位名——直接插值会把中文档位名带进英文句子。 */
function sysText(item: Extract<ChatItem, { kind: "sys" }>, t: T): string {
  if (!item.key) return item.text;
  if (item.key === "chat.sys.think") {
    const level = item.params?.level ?? "";
    return t("chat.sys.think", { level: t(THINK_KEY[level] ?? THINK_KEY[""]!) });
  }
  return t(item.key, item.params);
}

// memo:打字时 ChatView 每键重渲染(composer 草稿状态在那),消息流不能
// 跟着整列重排(长会话逐键重渲染几百张 markdown 卡 = 输入卡顿)。前提是
// 调用方传稳定引用回调(ChatView 侧 useCallback,见彼处注释)。
export const LogList = memo(function LogList({
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
  const { t, locale } = useI18n();
  // 长工具组折叠的展开记录(键 = 组首条目的 itemKey,keyBase 感知,前插
  // 不漂移);仅内存,切会话重挂即复位。open/closed 双集合:用户手动开合
  // 优先于「运行中默认展开、终态默认收起」的推导
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());
  const [closedGroups, setClosedGroups] = useState<Set<number>>(new Set());
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
  // 工具组聚合(用户定案 2026-08-05 二次:整串收一个块,头部给动作统计
  // 「N 步 · 读取 ×3 · 写入 ×2」):同组可见工具卡 ≥ AGG_MIN 时聚合——
  // 运行中/有待审批的组默认展开(要看得到当前动作与审批按钮),终态组
  // 默认收起;点头部行开合(思考块同交互),用户手动开合优先于默认。
  // 被收卡保 hidden 占位,DOM 仍与 items 一一对应
  const AGG_MIN = 3;
  const stackInfo = new Map<number, { start: number; len: number; pos: number; members: number[] }>();
  {
    let members: number[] = [];
    const flush = () => {
      const start = members[0];
      if (start !== undefined) {
        const shared = members;
        shared.forEach((idx, pos) => stackInfo.set(idx, { start, len: shared.length, pos, members: shared }));
      }
      members = [];
    };
    state.items.forEach((it, i) => {
      if (hiddenAt(i)) return; // 隐藏占位不断组
      if (it.kind === "tool") members.push(i);
      else flush();
    });
    flush();
  }
  const groupActive = (members: number[]) =>
    members.some((idx) => {
      const it = state.items[idx];
      return it?.kind === "tool" && (it.status === "run" || anchors.get(it.tcId)?.state === "open");
    });
  // 头部摘要:按动作词计数,保首现顺序,只列前三种
  const groupSummary = (members: number[]) => {
    const counts = new Map<string, number>();
    for (const idx of members) {
      const it = state.items[idx];
      if (it?.kind !== "tool") continue;
      const action = presentToolCall(it.title, it.rawInput, { locale, toolKind: it.toolKind, meta: it._meta }).action;
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
    const parts = [...counts.entries()].slice(0, 3).map(([a, c]) => (c > 1 ? `${a} ×${c}` : a));
    const more = counts.size > 3 ? " · …" : "";
    return `${t("chat.tool.groupSteps", { n: members.length })} · ${parts.join(" · ")}${more}`;
  };

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

        // 工具组聚合:组首渲染摘要头(+ 展开时的成员卡),其余成员在收起
        // 态保 hidden 占位
        const stack = item.kind === "tool" ? stackInfo.get(i) : undefined;
        if (stack && stack.len >= AGG_MIN) {
          const stackKey = itemKey(state, stack.start);
          const expanded = closedGroups.has(stackKey)
            ? false
            : openGroups.has(stackKey) || groupActive(stack.members);
          if (stack.pos > 0) {
            if (!expanded) return <div key={itemKey(state, i)} className="hidden" aria-hidden />;
            return (
              <div key={itemKey(state, i)} className="flex flex-col">
                {renderItem(item, { t, sessionId, anchors, flashSeq, sendFrame, readonly, onOpenChildSession, uploadUrl, onLocalLink, workdir, loadFullTool, joinPrev: true, joinNext })}
              </div>
            );
          }
          // 组首:摘要头(状态点 = 组内最要紧态;失败数着色外显)
          const failCount = stack.members.filter((idx) => {
            const it = state.items[idx];
            return it?.kind === "tool" && it.status === "fail";
          }).length;
          const tone = statusDot(groupActive(stack.members) ? "run" : failCount > 0 ? "fail" : "ok");
          const toggle = () => {
            if (expanded) {
              setClosedGroups((prev) => new Set(prev).add(stackKey));
              setOpenGroups((prev) => {
                const next = new Set(prev);
                next.delete(stackKey);
                return next;
              });
            } else {
              setOpenGroups((prev) => new Set(prev).add(stackKey));
              setClosedGroups((prev) => {
                const next = new Set(prev);
                next.delete(stackKey);
                return next;
              });
            }
          };
          return (
            <div key={itemKey(state, i)} className={`group relative flex flex-col${gapClass}`}>
              <MessageTime timestamp={item.kind === "tool" ? item.timestamp : undefined} className="absolute -top-3.5 start-0" />
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={t("chat.tool.groupLabel")}
                className={`card card-border flex-row items-center gap-2 overflow-hidden bg-base-100 px-3 py-2 text-xs ${expanded ? "rounded-b-none border-b-0" : ""} cursor-pointer`}
                onClick={toggle}
              >
                <span aria-hidden className={tone} />
                {/* 与单条工具卡的动作名同字重(都不加粗):两者在流里交替出现,
                    一个粗一个不粗会读成两级信息 */}
                <span className="min-w-0 flex-1 truncate text-start">{groupSummary(stack.members)}</span>
                {failCount > 0 && (
                  <span className="shrink-0 text-error">{t("chat.tool.groupFailed", { n: failCount })}</span>
                )}
                <IconChevronRight
                  size={12}
                  stroke={1.75}
                  aria-hidden
                  className={`shrink-0 text-base-content/40 transition-transform ${expanded ? "rotate-90" : ""}`}
                />
              </button>
              {expanded &&
                renderItem(item, { t, sessionId, anchors, flashSeq, sendFrame, readonly, onOpenChildSession, uploadUrl, onLocalLink, workdir, loadFullTool, joinPrev: true, joinNext })}
            </div>
          );
        }
        return (
          // 包裹 div 自身是 flex 列:系统行等条目的 self-center 才有对齐上下文
          // (包裹层是块级时 align-self 无效,居中丢失)
          <div key={itemKey(state, i)} className={`flex flex-col${gapClass}`}>
            {renderItem(item, { t, sessionId, anchors, flashSeq, sendFrame, readonly, onOpenChildSession, uploadUrl, onLocalLink, workdir, loadFullTool, joinPrev, joinNext })}
          </div>
        );
      })}
      {state.running && state.streamKind === "" && (
        <span className="loading loading-dots loading-sm mt-3 text-base-content/40" aria-hidden />
      )}
    </div>
  );
});
