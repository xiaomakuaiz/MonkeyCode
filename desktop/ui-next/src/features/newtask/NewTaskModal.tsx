// 新建任务:daisyUI modal。契约(与壳一致):
// - 本地会话:workdir 必填;默认目录 ~/MonkeyCode 允许静默创建(createDir)
// - 普通对话:workdir 传空串,隐藏 cwd 由壳生成;createDir 恒 false
// - 模型记忆 mc.lastTaskModel(本地/对话共用)
import { useEffect, useState } from "react";

import { useI18n } from "@/lib/i18n";
import { pickDirectory } from "@/lib/ipc/host";
import { modelsList, sessionCreate, type ModelInfo, type SessionKind, type SessionMeta } from "@/lib/ipc/sessions";
import { readLastTaskModel, rememberLastTaskModel } from "@/lib/util/prefs";
import { NewCloudTask } from "@/features/cloud/NewCloudTask";
import type { CloudTaskDetail } from "@/lib/ipc/cloudtasks";

export const DEFAULT_DIR = "~/MonkeyCode";

export function NewTaskModal({
  open,
  onClose,
  onCreated,
  onCloudCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (meta: SessionMeta) => void;
  onCloudCreated?: (task: CloudTaskDetail) => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<SessionKind | "cloud">("local");
  const [dir, setDir] = useState(DEFAULT_DIR);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void modelsList().then((list) => {
      if (!alive) return;
      setModels(list);
      const remembered = readLastTaskModel();
      const pick =
        (remembered && list.find((m) => m.name === remembered && !m.locked)) ||
        list.find((m) => m.default && !m.locked) ||
        list.find((m) => !m.locked);
      if (pick) setModel(pick.name);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  const submit = async () => {
    if (kind === "cloud") return;
    const chat = kind === "chat";
    const workdir = chat ? "" : dir.trim();
    if (!chat && !workdir) {
      setError(t("create.error.workdirRequired"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const meta = await sessionCreate({
        workdir,
        model,
        createDir: !chat && workdir === DEFAULT_DIR,
        kind: chat ? "chat" : "local",
      });
      if (model) rememberLastTaskModel(model);
      onCreated(meta);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <dialog open className="modal modal-open">
      <div className="modal-box max-w-sm">
        <h2 className="mb-3 text-base font-bold">{t("create.title")}</h2>
        <div className="flex flex-col gap-3">
          <div role="tablist" aria-label={t("create.title")} className="tabs-box tabs tabs-sm w-fit">
            {(["local", "chat", "cloud"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                className={`tab font-semibold ${kind === k ? "tab-active" : ""}`}
                onClick={() => setKind(k)}
              >
                {k === "local" ? t("create.kind.local") : k === "chat" ? t("create.kind.chat") : t("create.kind.cloud")}
              </button>
            ))}
          </div>
          {kind === "cloud" && (
            <NewCloudTask
              onCreated={(task) => {
                onCloudCreated?.(task);
                onClose();
              }}
              onCancel={onClose}
            />
          )}
          {kind === "local" && (
            <fieldset className="fieldset">
              <legend className="fieldset-legend">{t("create.workdir")}</legend>
              <div className="join w-full">
                <input
                  className="input input-sm join-item w-full font-mono text-xs"
                  aria-label={t("create.workdir")}
                  placeholder={t("create.workdirPlaceholder")}
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-sm join-item"
                  onClick={() => {
                    void pickDirectory().then((picked) => {
                      if (picked) setDir(picked);
                    });
                  }}
                >
                  {t("create.browse")}
                </button>
              </div>
            </fieldset>
          )}
          {kind !== "cloud" && (
          <fieldset className="fieldset">
            <legend className="fieldset-legend">{t("create.model")}</legend>
            <select
              className="select select-sm w-full"
              aria-label={t("create.model")}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.name} value={m.name} disabled={m.locked}>
                  {m.name}
                </option>
              ))}
            </select>
          </fieldset>
          )}
          {kind !== "cloud" && error && (
            <div role="alert" className="alert alert-error alert-soft py-1.5 text-xs">
              {error}
            </div>
          )}
        </div>
        {kind !== "cloud" && (
        <div className="modal-action">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            {t("create.cancel")}
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
            {busy && <span className="loading loading-spinner loading-xs" aria-hidden />}
            {t("create.submit")}
          </button>
        </div>
        )}
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </dialog>
  );
}
