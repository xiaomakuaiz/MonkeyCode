// 工具卡:状态点 + 标题 + 耗时;详情 collapse(入参/结果,mono 摘要);
// 子代理进度窗(只显尾部若干条,完整过程在子会话);失败外显 out 首行;
// report_findings 走结构化发现列表;锚定的待决审批内嵌卡底(独立大卡不渲染)。
import { Pause } from "lucide-react";

import { MarkdownInline } from "@/components/markdown/Markdown";
import { useI18n } from "@/lib/i18n";
import type { FrameSender } from "@/lib/ipc/approvals";
import { toolResultText } from "@/lib/protocol/codec";
import type { PermItem, SubEntry, ToolItem } from "@/lib/protocol/types";
import { FindingsCard, findingsReportFor } from "./FindingsCard";
import { PermActions } from "./PermCard";

/** 进度滚动窗口:固定只展示最后几条,旧条目自然滚出。 */
const FEED_WINDOW = 5;

/** 详情摘要的字符护栏(完整原文在帧里,详情面板只做可读摘要)。 */
const DETAIL_CLIP = 2000;

function clip(text: string): string {
  return text.length > DETAIL_CLIP ? `${text.slice(0, DETAIL_CLIP)} …` : text;
}

/** 入参的可读形态:字符串原样,结构化转 JSON(渲染前统一截断)。 */
function toolInputText(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return "";
  if (typeof rawInput === "string") return rawInput;
  try {
    return JSON.stringify(rawInput, null, 2) ?? "";
  } catch {
    return "";
  }
}

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

function FeedRow({ entry }: { entry: SubEntry }) {
  if (entry.kind === "text") {
    return <MarkdownInline source={entry.text} className="block min-w-0 truncate text-base-content/50" />;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden className={`status ${statusTone(entry.status)}`} />
      <span className="min-w-0 flex-1 truncate text-base-content/70" title={entry.title}>
        {entry.title}
      </span>
    </span>
  );
}

export function ToolCard({
  item,
  perm,
  sessionId,
  sendFrame,
  onOpenChild,
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
}) {
  const { t } = useI18n();
  const duration = formatDuration(item.durationMs);
  const findings = findingsReportFor(item);
  const feed = item.status === "run" ? (item.feed ?? []).slice(-FEED_WINDOW) : [];
  const feedBase = (item.feed?.length ?? 0) - feed.length;
  const input = clip(toolInputText(item.rawInput));
  const output = clip(toolResultText(item.rawOutput, item.content));
  const showDetail = item.status !== "run" && (input !== "" || output !== "");
  return (
    <div className="card overflow-hidden border border-base-300 bg-base-100" data-tool-id={item.tcId}>
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        {perm ? (
          <Pause size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-warning" />
        ) : (
          <span aria-hidden className={`status ${statusTone(item.status)}`} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium" title={item.title}>
          {item.title}
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
      </div>
      {findings && <FindingsCard report={findings} />}
      {feed.length > 0 && (
        <div className="flex flex-col gap-1 px-3 pb-2 ps-6 text-xs">
          {feed.map((entry, i) => (
            <FeedRow key={feedBase + i} entry={entry} />
          ))}
        </div>
      )}
      {item.status === "run" && item.lastLine && (
        <div className="truncate px-3 pb-2 ps-6 text-xs text-base-content/50 italic">{item.lastLine}</div>
      )}
      {item.status === "fail" && item.out && (
        <div role="alert" title={item.result || item.out} className="truncate px-3 pb-2 text-xs text-error">
          {item.out}
        </div>
      )}
      {showDetail && (
        <details className="collapse-arrow collapse rounded-none border-t border-base-300">
          <summary className="collapse-title min-h-0 px-3 py-1.5 text-xs text-base-content/50">
            {t("chat.tool.detail")}
          </summary>
          <div className="collapse-content flex flex-col gap-2 text-xs">
            {input && (
              <div>
                <div className="mb-1 text-base-content/40">{t("chat.tool.input")}</div>
                <pre className="overflow-x-auto rounded-box bg-base-200 p-2 font-mono break-all whitespace-pre-wrap select-text">{input}</pre>
              </div>
            )}
            {output && (
              <div>
                <div className="mb-1 text-base-content/40">{t("chat.tool.output")}</div>
                <pre className="overflow-x-auto rounded-box bg-base-200 p-2 font-mono break-all whitespace-pre-wrap select-text">{output}</pre>
              </div>
            )}
          </div>
        </details>
      )}
      {perm && (
        <div className="flex flex-col gap-2 border-t border-dashed border-warning/40 px-3 py-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-warning">
            <span>{t("chat.perm.needConfirm")}</span>
            {perm.tool && <span className="badge badge-warning badge-soft badge-xs font-mono">{perm.tool}</span>}
          </div>
          {/* key=perm.id:同一张工具卡先后锚定不同审批时,内嵌行的乐观态
              (local)随审批重置——否则二次 open 时按钮行被旧徽标顶掉 */}
          <PermActions key={perm.id} perm={perm} sessionId={sessionId} sendFrame={sendFrame} />
        </div>
      )}
    </div>
  );
}
