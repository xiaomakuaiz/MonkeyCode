// 审查发现列表(report_findings 工具卡体):每条一行——严重度点/徽标 +
// 摘要(行内 markdown)+ file:line(mono)+ 处置徽标,展开看完整描述与
// 失败场景。空列表渲染"未发现问题"完成态,而不是空白卡。
// 字段宽容解析(对表旧工程 findings.ts):旧 journal/异构引擎缺字段时
// 行内自然降级,不整卡放弃。
import { Markdown, MarkdownInline } from "@/components/markdown/Markdown";
import { useI18n, type MessageKey } from "@/lib/i18n";
import type { ToolItem } from "@/lib/protocol/types";

type UnknownRecord = Record<string, unknown>;

export interface ReviewFinding {
  file: string;
  line?: number;
  summary: string;
  /** 紧凑标签(引擎侧 ≤60 字符);缺省时行内退回 summary */
  shortSummary?: string;
  failureScenario?: string;
  category?: string;
  /** 核验结论:CONFIRMED/PLAUSIBLE(未核验则缺席) */
  verdict?: string;
  /** 处置结果:fixed/skipped/no_change_needed(修复后复报才有) */
  outcome?: string;
}

export interface FindingsReport {
  findings: ReviewFinding[];
  level?: string;
}

function rec(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseFindingsReport(rawInput: unknown): FindingsReport | null {
  const input = rec(rawInput);
  if (!input || !Array.isArray(input.findings)) return null;
  const findings: ReviewFinding[] = [];
  for (const entry of input.findings) {
    const f = rec(entry);
    if (!f) continue;
    const summary = str(f.summary) ?? str(f.short_summary);
    const file = str(f.file);
    if (!summary && !file) continue;
    findings.push({
      file: file ?? "",
      line: typeof f.line === "number" && Number.isFinite(f.line) && f.line > 0 ? Math.floor(f.line) : undefined,
      summary: summary ?? "",
      shortSummary: str(f.short_summary),
      failureScenario: str(f.failure_scenario),
      category: str(f.category),
      verdict: str(f.verdict),
      outcome: str(f.outcome),
    });
  }
  return { findings, level: str(input.level) };
}

/** report_findings 判定:标题首词(旧 journal 是 "ReportFindings …")或
 * ACP kind,大小写/连字符/下划线归一后比对;命中才解析 rawInput。 */
export function findingsReportFor(item: Pick<ToolItem, "title" | "toolKind" | "rawInput">): FindingsReport | null {
  const norm = (v: string) => v.toLowerCase().replace(/[_-]/g, "");
  const token = (item.title.trim().split(/\s+/)[0] ?? "").replace(/:+$/, "");
  const hit = norm(token) === "reportfindings" || norm(item.toolKind ?? "") === "reportfindings";
  return hit ? parseFindingsReport(item.rawInput) : null;
}

interface BadgeSpec {
  key: MessageKey | null;
  raw?: string;
  cls: string;
}

function verdictBadge(verdict?: string): BadgeSpec | null {
  if (verdict === "CONFIRMED") return { key: "chat.findings.confirmed", cls: "badge badge-error badge-soft badge-xs" };
  if (verdict === "PLAUSIBLE") return { key: "chat.findings.plausible", cls: "badge badge-warning badge-soft badge-xs" };
  return null;
}

function outcomeBadge(outcome?: string): BadgeSpec | null {
  switch (outcome) {
    case "fixed":
      return { key: "chat.findings.fixed", cls: "badge badge-success badge-soft badge-xs" };
    case "skipped":
      return { key: "chat.findings.skipped", cls: "badge badge-warning badge-soft badge-xs" };
    case "no_change_needed":
      return { key: "chat.findings.noChange", cls: "badge badge-ghost badge-xs" };
  }
  // 未来枚举扩展时至少原样可见,不无声吞掉
  return outcome ? { key: null, raw: outcome, cls: "badge badge-ghost badge-xs" } : null;
}

function FindingRow({ finding }: { finding: ReviewFinding }) {
  const { t } = useI18n();
  const title = finding.shortSummary || finding.summary;
  // 展开块只放行内没有的信息:完整一句话(与行内不同时)+ 失败场景
  const detail = [
    finding.summary && finding.summary !== title ? finding.summary : "",
    finding.failureScenario ? `**${t("chat.findings.failure")}**:${finding.failureScenario}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const filename = finding.file.split(/[\\/]/).pop() ?? "";
  const location = filename ? (finding.line ? `${filename}:${finding.line}` : filename) : "";
  const dot =
    finding.verdict === "CONFIRMED" ? "status-error" : finding.verdict === "PLAUSIBLE" ? "status-warning" : "status-neutral";
  const verdict = verdictBadge(finding.verdict);
  const outcome = outcomeBadge(finding.outcome);
  const row = (
    <>
      <span aria-hidden className={`status ${dot}`} />
      {verdict && <span className={verdict.cls}>{verdict.key ? t(verdict.key) : verdict.raw}</span>}
      <MarkdownInline source={title} className="min-w-0 flex-1" />
      {location && (
        <span title={finding.file + (finding.line ? `:${finding.line}` : "")} className="font-mono whitespace-nowrap text-base-content/50">
          {location}
        </span>
      )}
      {outcome && <span className={outcome.cls}>{outcome.key ? t(outcome.key) : outcome.raw}</span>}
    </>
  );
  if (!detail) return <div className="flex items-center gap-2 text-xs">{row}</div>;
  return (
    <details className="text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2">{row}</summary>
      <div className="mt-1 border-s-2 border-base-300 ps-3">
        <Markdown source={detail} className="opacity-80" />
      </div>
    </details>
  );
}

export function FindingsCard({ report }: { report: FindingsReport }) {
  const { t } = useI18n();
  if (report.findings.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 pb-2 text-xs text-base-content/60">
        <span aria-hidden className="status status-success" />
        {t("chat.findings.empty")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2">
      {report.findings.map((finding, i) => (
        <FindingRow key={i} finding={finding} />
      ))}
    </div>
  );
}
