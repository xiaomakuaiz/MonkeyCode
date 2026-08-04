// 工具卡:状态点 + 「动作 + 目标」标题(lib/tools 语义层)+ 耗时;详情
// collapse 按 toolDetailFor 分型(diff/command/text/json);大字段凭
// _meta.mcSrc.seq 按需回读原帧补全;子代理进度窗(只显尾部若干条)与
// 子会话入口缺席时的「查看结果」兜底;失败外显 out 首行;report_findings
// 走结构化发现列表;锚定的待决审批内嵌卡底(独立大卡不渲染)。
import { Pause } from "lucide-react";
import { useEffect, useState } from "react";

import { Markdown, MarkdownInline } from "@/components/markdown/Markdown";
import { Lightbox, UploadImg } from "@/components/media/UploadImg";
import { DiffView } from "@/features/files/DiffView";
import { useI18n } from "@/lib/i18n";
import type { FrameSender } from "@/lib/ipc/approvals";
import { isImagePath } from "@/lib/ipc/uploads";
import { frameData, toolResultText } from "@/lib/protocol/codec";
import type { AcpUpdate, Frame, PermItem, SubEntry, ToolItem } from "@/lib/protocol/types";
import { stripWorkdir } from "@/lib/tools/stripWorkdir";
import { toolDetailFor, type ToolDetail } from "@/lib/tools/toolDetails";
import { presentToolCall, toolDisplayName, type ToolTargetKind } from "@/lib/tools/toolLabels";
import { FindingsCard, findingsReportFor } from "./FindingsCard";
import { PermActions } from "./PermCard";

/** 进度滚动窗口:固定只展示最后几条,旧条目自然滚出。 */
const FEED_WINDOW = 5;

/** 只显示可靠的最终耗时;没有完整起止时间时宁可留空。 */
function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function statusTone(status: "run" | "ok" | "fail"): string {
  return status === "fail" ? "status-error" : status === "run" ? "status-primary animate-pulse" : "status-success";
}

/** 目标文本:path 型截断目录段、保住末段文件名可见(旧 UI ToolTargetText
 * 布局);完整值始终放 title 悬停,不在数据层截断。 */
function ToolTargetText({
  target,
  fullTarget,
  kind,
}: {
  target: string;
  fullTarget?: string;
  kind: ToolTargetKind;
}) {
  if (kind !== "path") {
    return (
      <span title={fullTarget || target} className="min-w-0 flex-1 truncate font-mono text-base-content/60">
        {target}
      </span>
    );
  }
  const split = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  const hasFilename = split >= 0 && split < target.length - 1;
  const directory = hasFilename ? target.slice(0, split + 1) : "";
  const filename = hasFilename ? target.slice(split + 1) : target;
  return (
    <span title={fullTarget || target} className="flex min-w-0 flex-1 font-mono whitespace-nowrap">
      {directory && <span className="min-w-3 truncate text-base-content/40">{directory}</span>}
      <span className="max-w-[70%] shrink-0 truncate text-base-content/60">{filename}</span>
    </span>
  );
}

/** 子代理进度行:工具步骤同样过 presentToolCall(动作 + 目标),文本行走
 * 行内 Markdown。 */
function FeedRow({ entry, workdir }: { entry: SubEntry; workdir?: string }) {
  const { locale } = useI18n();
  if (entry.kind === "text") {
    return <MarkdownInline source={entry.text} className="block min-w-0 truncate text-base-content/50" />;
  }
  const sub = presentToolCall(entry.title, entry.rawInput, locale);
  const target = sub.targetKind === "path" ? stripWorkdir(sub.target, workdir) : sub.target;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden className={`status ${statusTone(entry.status)}`} />
      <span className="shrink-0 text-base-content/70" title={entry.title}>
        {sub.action}
      </span>
      {target && <ToolTargetText target={target} fullTarget={sub.target} kind={sub.targetKind} />}
    </span>
  );
}

/** 详情正文的等宽块:横滚只许出现在 pre/diff 区(§5),纵向 50vh 封顶。 */
const PRE_CLASS =
  "max-h-[50vh] overflow-x-auto overflow-y-auto rounded-box bg-base-200 p-2 font-mono break-all whitespace-pre-wrap select-text";

/** 详情面板分型渲染:diff 复用 FilesDrawer 的 DiffView 行模型;command 走
 * `$ 命令`(+cwd 弱化行)+ 输出 pre;text/json 维持纯文本 pre。 */
function DetailBody({ detail }: { detail: ToolDetail }) {
  const { t } = useI18n();
  if (detail.kind === "diff") {
    return (
      <div className="max-h-[50vh] overflow-auto rounded-box border border-base-300">
        <DiffView text={detail.text} />
      </div>
    );
  }
  if (detail.kind === "command") {
    return (
      <div className="flex flex-col gap-1">
        {detail.command && (
          <pre className={PRE_CLASS}>
            <span aria-hidden className="text-base-content/40 select-none">
              {"$ "}
            </span>
            {detail.command}
            {detail.cwd && <span className="block text-base-content/40">{detail.cwd}</span>}
          </pre>
        )}
        {detail.output ? (
          <pre className={PRE_CLASS}>{detail.output}</pre>
        ) : (
          <div className="text-base-content/40">{t("chat.tool.emptyOutput")}</div>
        )}
      </div>
    );
  }
  return <pre className={PRE_CLASS}>{detail.text}</pre>;
}

export function ToolCard({
  item,
  perm,
  sessionId,
  sendFrame,
  onOpenChild,
  uploadUrl,
  onLocalLink,
  workdir,
  loadFullTool,
}: {
  item: ToolItem;
  /** 锚定到本卡的待决审批(permAnchors 判定):⏸ 顶掉状态点 + 底部内嵌
   * 按钮行,独立审批大卡随之不渲染;已决后调用方不再传入,卡片回归常态 */
  perm?: PermItem;
  sessionId: string;
  /** 内嵌审批行的上行管道注入(云端任务经 stream WS);缺省 = 本地 sender */
  sendFrame?: FrameSender;
  /** 子代理卡「查看子会话」入口(item.childSessionId 存在时渲染) */
  onOpenChild?: (id: string) => void;
  /** 工具产出图片的回读通道(截图/读图工具);缺省不渲染图片区 */
  uploadUrl?: (path: string) => Promise<string>;
  /** 子代理结果 Markdown 里工作区文件链接的安全打开动作 */
  onLocalLink?: (path: string) => void;
  /** 会话工作目录:path 型目标剥绝对前缀(悬停仍露完整路径) */
  workdir?: string;
  /** 回读被截断的工具大字段原帧(壳侧物化超限截断,凭 _meta.mcSrc.seq);
   * 不传则只展示行内的截断头部 */
  loadFullTool?: (seq: number) => Promise<Frame>;
}) {
  const { t, locale } = useI18n();
  const [zoom, setZoom] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [showAgentResult, setShowAgentResult] = useState(false);
  // 大字段护栏的另一半:行内只有截断头部时,展开即按 seq 回读原帧补全。
  // 截断与回读必须成对存在——只截不读会把子代理的最终产出切掉半截。
  const srcSeq = (item._meta as { mcSrc?: { seq?: number } } | undefined)?.mcSrc?.seq;
  const [full, setFull] = useState<AcpUpdate | null>(null);
  const [fullErr, setFullErr] = useState("");
  const [loadingFull, setLoadingFull] = useState(false);
  const wantFull = detailOpen || showAgentResult;
  useEffect(() => {
    if (!wantFull || srcSeq === undefined || full || loadingFull || fullErr || !loadFullTool) return;
    setLoadingFull(true);
    loadFullTool(srcSeq)
      .then((f) => {
        const update = frameData<{ update?: AcpUpdate }>(f)?.update;
        if (update) setFull(update);
        else setFullErr(t("chat.tool.sourceGone"));
      })
      .catch((e: unknown) => setFullErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingFull(false));
  }, [wantFull, srcSeq, full, loadingFull, fullErr, loadFullTool, t]);

  const images = uploadUrl ? (item.images ?? []).filter(isImagePath) : [];
  const duration = formatDuration(item.durationMs);
  const feed = item.feed ?? [];
  // 子代理卡沿用「子会话/查看结果」;其余本地与云端工具统一走结构化详情
  const isAgentCard = !!(item.childSessionId || feed.length || item.background);
  const agentFinished = isAgentCard && item.status !== "run";
  const canOpenChild = !!(item.childSessionId && onOpenChild);
  const visibleFeed = item.status === "run" ? feed.slice(-FEED_WINDOW) : [];
  const feedBase = feed.length - visibleFeed.length;

  // 动作取标题,目标优先取完整 rawInput;path 型剥 workdir 前缀,
  // 悬停 title 保留原始标题与完整目标
  const presentation = presentToolCall(item.title, item.rawInput, { locale, toolKind: item.toolKind, meta: item._meta });
  const fullTarget = presentation.target;
  const target = presentation.targetKind === "path" ? stripWorkdir(fullTarget, workdir) : fullTarget;

  // 回读到全文后用全文渲染详情;没有护栏标记时 full 恒为 null,行为不变
  const shown = full
    ? {
        ...item,
        ...(full.rawInput !== undefined ? { rawInput: full.rawInput } : {}),
        ...(full.rawOutput !== undefined ? { rawOutput: full.rawOutput } : {}),
        ...(full.content !== undefined ? { content: full.content } : {}),
      }
    : item;
  const findings = findingsReportFor(shown);
  const detail = !isAgentCard && shown.status !== "run" ? toolDetailFor(shown) : null;
  const fullResult = full ? toolResultText(full.rawOutput, full.content) : "";
  // 极端情况下子会话入口缺失(云端只读流/旧 journal),保留按需展开兜底,
  // 但不默认把整段结果灌进卡片
  const agentResult = agentFinished ? (fullResult || item.result || "").trim() : "";
  const summary = agentResult && !canOpenChild && showAgentResult ? agentResult : "";
  return (
    <div className="card card-border overflow-hidden bg-base-100" data-tool-id={item.tcId}>
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        {perm ? (
          <Pause size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-warning" />
        ) : (
          <span aria-hidden className={`status ${statusTone(item.status)}`} />
        )}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 font-medium" title={item.title}>
            {presentation.action}
          </span>
          {target && <ToolTargetText target={target} fullTarget={fullTarget} kind={presentation.targetKind} />}
        </span>
        {duration && <span className="font-mono text-base-content/40 tabular-nums">{duration}</span>}
        {item.childSessionId && onOpenChild && (
          <button
            type="button"
            className="link link-hover link-primary shrink-0 text-xs font-semibold"
            onClick={() => onOpenChild(item.childSessionId!)}
          >
            {t("chat.tool.childSession")}
          </button>
        )}
        {agentResult && !canOpenChild && (
          <button
            type="button"
            className="link link-hover shrink-0 text-xs font-semibold text-base-content/60"
            onClick={() => setShowAgentResult((v) => !v)}
          >
            {showAgentResult ? t("chat.tool.hideResult") : t("chat.tool.showResult")}
          </button>
        )}
      </div>
      {/* 发现行的 file:line 复用工作区文件链接通道(ChatView revealMarkdownLink) */}
      {findings && <FindingsCard report={findings} onOpenFile={onLocalLink} />}
      {visibleFeed.length > 0 && (
        <div className="flex flex-col gap-1 px-3 pb-2 ps-6 text-xs">
          {visibleFeed.map((entry, i) => (
            <FeedRow key={feedBase + i} entry={entry} workdir={workdir} />
          ))}
        </div>
      )}
      {item.status === "run" && item.lastLine && (
        <div className="truncate px-3 pb-2 ps-6 text-xs text-base-content/50 italic">{item.lastLine}</div>
      )}
      {item.status === "fail" && item.out && !summary && (
        <div role="alert" title={item.result || item.out} className="truncate px-3 pb-2 text-xs text-error">
          {item.out}
        </div>
      )}
      {/* 子代理「查看结果」兜底:结果走 Markdown,结构线左缘与正文区分 */}
      {summary && (
        <div className="mx-3 mb-2 border-s-2 border-base-300 ps-3 text-sm">
          <Markdown source={summary} localImageUrl={uploadUrl} onLocalLink={onLocalLink} />
        </div>
      )}
      {/* 工具产出图片(截图/读图):缩略图点击看大图;裂图防御在 UploadImg */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2 ps-6">
          {images.map((p) => (
            <UploadImg
              key={p}
              load={() => uploadUrl!(p)}
              alt={p}
              title={p}
              className="block max-h-32 max-w-44 cursor-zoom-in rounded-box"
              onClick={() => setZoom(p)}
            />
          ))}
        </div>
      )}
      {zoom && uploadUrl && (
        <Lightbox alt={zoom} onClose={() => setZoom(null)}>
          <UploadImg load={() => uploadUrl(zoom)} alt={zoom} className="max-h-[84vh] max-w-full" />
        </Lightbox>
      )}
      {/* 大字段回读的 loading/失败态行内外显(展开详情或查看结果时触发) */}
      {wantFull &&
        (fullErr ? (
          <div role="alert" className="px-3 pb-2 text-xs text-error">
            {t("chat.tool.loadFullFailed", { reason: fullErr })}
          </div>
        ) : loadingFull ? (
          <div role="status" className="flex items-center gap-2 px-3 pb-2 text-xs text-base-content/50">
            <span className="loading loading-spinner loading-xs" aria-hidden />
            {t("chat.tool.loadingFull")}
          </div>
        ) : null)}
      {detail && (
        <details className="collapse-arrow collapse rounded-none border-t border-base-300" open={detailOpen}>
          {/* 受控 details:preventDefault 掉原生切换,open 状态即回读触发器 */}
          <summary
            className="collapse-title min-h-0 px-3 py-1.5 text-xs text-base-content/50"
            onClick={(e) => {
              e.preventDefault();
              setDetailOpen((v) => !v);
            }}
          >
            {t("chat.tool.detail")}
          </summary>
          <div className="collapse-content flex flex-col text-xs">
            <DetailBody detail={detail} />
          </div>
        </details>
      )}
      {perm && (
        <div className="flex flex-col gap-2 border-t border-base-300 px-3 py-2">
          <div className="text-xs font-semibold text-warning">
            {`${t("chat.perm.needConfirm")} · ${perm.tool ? toolDisplayName(perm.tool, locale) : t("chat.perm.genericAction")}`}
          </div>
          {/* key=perm.id:同一张工具卡先后锚定不同审批时,内嵌行的乐观态
              (local)随审批重置——否则二次 open 时按钮行被旧徽标顶掉 */}
          <PermActions key={perm.id} perm={perm} sessionId={sessionId} sendFrame={sendFrame} />
        </div>
      )}
    </div>
  );
}
