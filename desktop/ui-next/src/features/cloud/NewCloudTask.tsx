// 新建云端任务面板:mc_task_options 三选器(模型/宿主机/镜像)+ 任务描述,
// 提交 mc_task_create(壳补默认档位:公共宿主机/opencode/2核8G3小时/官方技能)。
// 导出纯面板组件(不带 dialog 壳),newtask 弹窗接线由 App 侧完成。
// 默认值规则与 Web/mobile 同源(lib/cloud/options 纯函数):
// - 模型:会员档匹配的内置档 → 公共 → 任意;locked(超会员档)禁选;
// - 宿主机:服务端 task_defaults 有效则用,否则公共宿主;公共模型强制公共宿主;
// - 镜像:公共 devbox → is_default → 第一个。
import { useEffect, useState } from "react";

import {
  cloudHostLabel,
  cloudImageLabel,
  cloudModelLabel,
  isPublicModel,
  pickDefaultCloudHost,
  pickDefaultCloudImage,
  pickDefaultCloudModel,
  usableCloudHosts,
  usableCloudModels,
} from "@/lib/cloud/options";
import { useI18n } from "@/lib/i18n";
import { mcTaskCreate, mcTaskOptions, type CloudTaskDetail, type McTaskOptions } from "@/lib/ipc/cloudtasks";

export function NewCloudTask({
  onCreated,
  onCancel,
}: {
  onCreated: (task: CloudTaskDetail) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const [options, setOptions] = useState<McTaskOptions | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [content, setContent] = useState("");
  const [modelId, setModelId] = useState("");
  const [hostId, setHostId] = useState("");
  const [imageId, setImageId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    mcTaskOptions()
      .then((o) => {
        if (!alive) return;
        setOptions(o);
        const model = pickDefaultCloudModel(o.models, o.plan);
        setModelId(model);
        setHostId(pickDefaultCloudHost(o.hosts, o.task_defaults?.host_id ?? "", isPublicModel(o.models, model)));
        setImageId(pickDefaultCloudImage(o.images));
      })
      .catch((e: unknown) => {
        if (alive) setLoadErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const models = options ? usableCloudModels(options.models, options.plan) : [];
  const publicModel = options ? isPublicModel(options.models, modelId) : false;
  const hosts = options ? usableCloudHosts(options.hosts, publicModel) : [];
  const images = options?.images ?? [];

  // 公共模型只能跑公共宿主:模型切换后当前宿主可能不在可选集里,拉回默认
  const effectiveHostId = hosts.some((h) => h.id === hostId) ? hostId : (hosts[0]?.id ?? "");

  const submit = async () => {
    if (!content.trim()) {
      setError(t("cloud.new.error.content"));
      return;
    }
    if (!modelId || !imageId) {
      setError(t("cloud.new.error.missing"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const task = await mcTaskCreate({
        content: content.trim(),
        model_id: modelId,
        host_id: effectiveHostId,
        image_id: imageId,
      });
      onCreated(task);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-bold">{t("cloud.new.title")}</h2>

      {loadErr && (
        <div role="alert" className="alert alert-error alert-soft py-1.5 text-xs">
          {t("cloud.new.optionsFailed", { reason: loadErr })}
        </div>
      )}
      {!options && !loadErr && (
        <div className="flex items-center gap-2 py-4 text-xs text-base-content/50">
          <span className="loading loading-spinner loading-xs" aria-hidden />
          {t("cloud.new.loading")}
        </div>
      )}

      {options && (
        <>
          <fieldset className="fieldset">
            <legend className="fieldset-legend">{t("cloud.new.content")}</legend>
            <textarea
              className="textarea textarea-sm min-h-20 w-full text-sm"
              aria-label={t("cloud.new.content")}
              placeholder={t("cloud.new.contentPlaceholder")}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset-legend">{t("cloud.new.model")}</legend>
            <select
              className="select select-sm w-full"
              aria-label={t("cloud.new.model")}
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id} disabled={m.locked}>
                  {cloudModelLabel(m)}
                  {m.locked ? t("cloud.model.locked") : ""}
                </option>
              ))}
            </select>
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset-legend">{t("cloud.new.host")}</legend>
            <select
              className="select select-sm w-full"
              aria-label={t("cloud.new.host")}
              value={effectiveHostId}
              onChange={(e) => setHostId(e.target.value)}
              disabled={publicModel}
            >
              {hosts.map((hostItem) => (
                <option key={hostItem.id} value={hostItem.id}>
                  {cloudHostLabel(hostItem)}
                </option>
              ))}
            </select>
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset-legend">{t("cloud.new.image")}</legend>
            <select
              className="select select-sm w-full"
              aria-label={t("cloud.new.image")}
              value={imageId}
              onChange={(e) => setImageId(e.target.value)}
            >
              {images.map((img) => (
                <option key={img.id} value={img.id}>
                  {cloudImageLabel(img)}
                </option>
              ))}
            </select>
          </fieldset>
        </>
      )}

      {error && (
        <div role="alert" className="alert alert-error alert-soft py-1.5 text-xs">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            {t("cloud.new.cancel")}
          </button>
        )}
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !options} onClick={() => void submit()}>
          {busy && <span className="loading loading-spinner loading-xs" aria-hidden />}
          {t("cloud.new.submit")}
        </button>
      </div>
    </div>
  );
}
