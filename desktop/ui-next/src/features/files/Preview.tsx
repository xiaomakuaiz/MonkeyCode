// 预览窗格:头部(文件名 + 全路径 + 改动徽标 + 关闭)+ 三态主体
// (loading/error/ready),ready 再按模式分流——文件(空/二进制占位、
// 代码高亮)与 diff(空 diff 占位、unified diff 渲染)。超限文件在壳侧
// 以 {error} 拒绝,走 error 态外显原因。
import { useI18n } from "@/lib/i18n";
import { CodeView } from "./CodeView";
import { DiffView } from "./DiffView";
import { basename, statusMeta } from "./status";

export type PreviewMode = "file" | "diff";

export interface PreviewModel {
  path: string;
  mode: PreviewMode;
  state: "loading" | "error" | "ready";
  /** ready:文件内容或 diff 文本;error:错误消息;loading:空串 */
  text: string;
}

export function Preview({ model, status, onClose }: { model: PreviewModel; status?: string; onClose: () => void }) {
  const { t } = useI18n();
  const meta = status ? statusMeta(status) : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-t border-base-300 bg-base-200/40 px-4 py-1.5">
        <span className="shrink-0 font-mono text-xs font-semibold">{basename(model.path)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-base-content/45">{model.path}</span>
        {meta && <span className={`badge badge-soft badge-xs shrink-0 ${meta.badgeClass}`}>{t(meta.labelKey)}</span>}
        <button
          type="button"
          aria-label={t("files.preview.close")}
          title={t("files.preview.close")}
          onClick={onClose}
          className="btn btn-ghost btn-square btn-xs shrink-0"
        >
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PreviewBody model={model} />
      </div>
    </div>
  );
}

function PreviewBody({ model }: { model: PreviewModel }) {
  const { t } = useI18n();
  if (model.state === "loading") {
    return (
      <div role="status" className="flex items-center gap-2 px-4 py-3 text-xs text-base-content/50">
        <span className="loading loading-spinner loading-xs" aria-hidden />
        {t("files.loading")}
      </div>
    );
  }
  if (model.state === "error") {
    return <p role="alert" className="px-4 py-3 font-mono text-xs text-error">{t("files.preview.error", { message: model.text })}</p>;
  }
  if (model.mode === "diff") {
    if (!model.text.trim()) return <Placeholder text={t("files.preview.noDiff")} />;
    return <DiffView text={model.text} />;
  }
  if (!model.text) return <Placeholder text={t("files.preview.empty")} />;
  if (model.text.includes("\0")) return <Placeholder text={t("files.preview.binary")} />;
  return <CodeView path={model.path} text={model.text} />;
}

function Placeholder({ text }: { text: string }) {
  return <p className="px-4 py-3 text-xs text-base-content/50">{text}</p>;
}
