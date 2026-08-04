// 全局下载条:右下角 toast 栈,跨视图常显(daisyUI toast + progress)。
import { X } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import {
  cancelDownload,
  dismissDownload,
  revealDownload,
  useDownloads,
  type DownloadItem,
} from "@/lib/ipc/downloads";

function DownloadCard({ item }: { item: DownloadItem }) {
  const { t } = useI18n();
  const pct = item.total ? Math.min(100, Math.round((item.written / item.total) * 100)) : null;
  return (
    <div className="card card-border w-72 bg-base-100 shadow-md">
      <div className="flex flex-col gap-1.5 p-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium" title={item.filename}>
            {item.filename}
          </span>
          {item.state === "running" ? (
            <button type="button" className="btn btn-ghost btn-square btn-xs" aria-label={t("downloads.cancel")} onClick={() => cancelDownload(item.dlId)}>
              <X size={14} strokeWidth={1.75} aria-hidden />
            </button>
          ) : (
            <button type="button" className="btn btn-ghost btn-square btn-xs" aria-label={t("downloads.dismiss")} onClick={() => dismissDownload(item.dlId)}>
              <X size={14} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>
        {item.state === "running" &&
          (pct === null ? (
            <progress className="progress progress-primary w-full" aria-label={t("downloads.progress")} />
          ) : (
            <progress className="progress progress-primary w-full" aria-label={t("downloads.progress")} value={pct} max={100} />
          ))}
        {item.state === "done" && (
          <button type="button" className="link link-primary self-start" onClick={() => revealDownload(item)}>
            {t("downloads.reveal")}
          </button>
        )}
        {item.state === "error" && <span className="text-error">{t("downloads.failed", { reason: item.error ?? "" })}</span>}
        {item.state === "canceled" && <span className="text-base-content/50">{t("downloads.canceled")}</span>}
      </div>
    </div>
  );
}

export function DownloadsDock() {
  const downloads = useDownloads();
  if (downloads.length === 0) return null;
  return (
    <div className="toast toast-end z-50">
      {downloads.map((d) => (
        <DownloadCard key={d.dlId} item={d} />
      ))}
    </div>
  );
}
