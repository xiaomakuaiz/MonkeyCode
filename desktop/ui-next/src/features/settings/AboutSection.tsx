// 关于:宿主/内核版本对照 + 检查更新(复用 lib/ipc/update)+ 导出引擎日志 +
// 打开扩展目录。更新安装成功后壳自行重启,installing 态不回收(与侧栏
// useUpdate 同一语义);导出/打开的失败是壳的中文 Err,直接外显。
import { useEffect, useState } from "react";

import { useI18n } from "@/lib/i18n";
import { exportEngineLog, openExtensionDir } from "@/lib/ipc/config";
import { hostInfo, type HostInfo } from "@/lib/ipc/host";
import { updateCheck, updateInstall, type UpdateInfo } from "@/lib/ipc/update";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function AboutSection() {
  const { t } = useI18n();
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "installing">("idle");
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    void hostInfo().then((v) => {
      if (alive) setInfo(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const check = async () => {
    setPhase("checking");
    setMsg(null);
    const s = await updateCheck(); // 失败/浏览器模式均为 null(update.ts 收口)
    setPhase("idle");
    if (!s) {
      setMsg({ text: t("settings.about.checkFailed"), error: true });
      return;
    }
    setUpdate(s);
    setMsg(
      s.available
        ? { text: t("settings.about.available", { latest: s.latest ?? "", current: s.current }) }
        : { text: t("settings.about.upToDate", { current: s.current }) },
    );
  };

  const install = () => {
    setPhase("installing");
    void updateInstall(); // 成功后壳自行重启,不会返回;失败静默(与 useUpdate 一致)
  };

  const exportLog = async () => {
    setMsg(null);
    try {
      const dest = await exportEngineLog();
      if (dest) setMsg({ text: t("settings.about.exported", { path: dest }) });
      // null = 用户取消/浏览器模式:静默
    } catch (e) {
      setMsg({ text: errMsg(e), error: true });
    }
  };

  const openExt = async () => {
    setMsg(null);
    try {
      await openExtensionDir();
    } catch (e) {
      setMsg({ text: errMsg(e), error: true });
    }
  };

  const busy = phase !== "idle";
  const found = !!update?.available;
  const updateLabel =
    phase === "checking"
      ? t("settings.about.checking")
      : phase === "installing"
        ? t("settings.about.installing")
        : found
          ? t("settings.about.install")
          : t("settings.about.check");

  return (
    <section aria-label={t("settings.nav.about")} className="flex max-w-xl flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-bold">{t("app.name")}</span>
        <span className="font-mono text-xs text-base-content/60">
          {t("settings.about.version", {
            version: info?.version ?? "—",
            engine: info?.engine_version ?? t("settings.about.engineNotReady"),
          })}
        </span>
      </div>
      {msg && (
        <div
          role={msg.error ? "alert" : "status"}
          className={msg.error ? "alert alert-error alert-soft py-1.5 text-xs" : "alert alert-success alert-soft py-1.5 text-xs"}
        >
          {msg.text}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={found ? "btn btn-primary btn-sm" : "btn btn-sm"}
          disabled={busy}
          onClick={() => void (found ? install() : check())}
        >
          {busy && <span className="loading loading-spinner loading-xs" aria-hidden />}
          {updateLabel}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void exportLog()}>
          {t("settings.about.exportLog")}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void openExt()}>
          {t("settings.about.openExtension")}
        </button>
      </div>
    </section>
  );
}
