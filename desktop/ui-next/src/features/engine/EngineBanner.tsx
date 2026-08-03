// 引擎状态横幅:崩溃/启动失败时置顶 alert,重启与日志入口。
// starting 有 3 秒宽限——快启动不闪横幅;ready/stopped 不渲染。
import { useEffect, useState } from "react";

import { useI18n } from "@/lib/i18n";
import { engineRestart, engineStatus, onEngineStatus, type EngineStatus } from "@/lib/ipc/engine";
import { openLogDir } from "@/lib/ipc/host";

const STARTING_GRACE_MS = 3000;

export function EngineBanner() {
  const { t } = useI18n();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [graceOver, setGraceOver] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let alive = true;
    void engineStatus().then((s) => {
      if (alive && s) setStatus(s);
    });
    const off = onEngineStatus((s) => {
      setStatus(s);
      setRestarting(false);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const phase = status?.phase;
  useEffect(() => {
    setGraceOver(false);
    if (phase !== "starting") return;
    const timer = window.setTimeout(() => setGraceOver(true), STARTING_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (!status || phase === "ready" || phase === "stopped") return null;

  if (phase === "starting") {
    if (!graceOver) return null;
    return (
      <div role="status" className="alert alert-warning alert-soft rounded-none py-1.5 text-xs">
        <span className="loading loading-spinner loading-xs" aria-hidden />
        <span>{t("engine.starting", { attempt: status.attempt })}</span>
      </div>
    );
  }

  const detail = status.phase === "crashed" ? status.detail : status.phase === "failed" ? status.error : "";
  return (
    <div role="alert" className="alert alert-error alert-soft rounded-none py-1.5 text-xs">
      <span className="min-w-0 flex-1 truncate" title={detail}>
        {t(status.phase === "crashed" ? "engine.crashed" : "engine.failed", { detail })}
      </span>
      <button
        type="button"
        className="btn btn-error btn-xs"
        disabled={restarting}
        onClick={() => {
          setRestarting(true);
          void engineRestart();
        }}
      >
        {restarting && <span className="loading loading-spinner loading-xs" aria-hidden />}
        {t("engine.restart")}
      </button>
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => void openLogDir()}>
        {t("engine.logs")}
      </button>
    </div>
  );
}
