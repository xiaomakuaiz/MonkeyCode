// 模型列表编辑:行内受控展开(一次一行),增删改与"设为默认"。
// 表单只呈现核心字段(名称/协议/接口地址/API Key/模型标识/思考深度);
// 高级字段(context_window/max_output/vision)与同步标记(source/locked/owner)
// 留在草稿对象里随保存透传,不因编辑丢失。
import { useState } from "react";

import { useI18n } from "@/lib/i18n";
import type { HostModel } from "@/lib/ipc/config";
import { emptyModel, type SettingsDraft } from "./settingsForm";

export function ModelsSection({
  draft,
  onDraft,
}: {
  draft: SettingsDraft;
  onDraft: (up: (d: SettingsDraft) => SettingsDraft) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<number | null>(null);

  const patch = (i: number, p: Partial<HostModel>) =>
    onDraft((d) => ({ ...d, models: d.models.map((m, j) => (j === i ? { ...m, ...p } : m)) }));

  const remove = (i: number) => {
    onDraft((d) => ({
      ...d,
      models: d.models.filter((_, j) => j !== i),
      defaultIdx: i < d.defaultIdx ? d.defaultIdx - 1 : i === d.defaultIdx ? 0 : d.defaultIdx,
    }));
    setExpanded(null);
  };

  const add = () => {
    setExpanded(draft.models.length);
    onDraft((d) => ({ ...d, models: [...d.models, emptyModel()] }));
  };

  return (
    <section aria-label={t("settings.nav.models")} className="flex max-w-2xl flex-col gap-2">
      {draft.models.length === 0 && <p className="text-sm text-base-content/60">{t("settings.models.empty")}</p>}
      {draft.models.map((m, i) => {
        const open = expanded === i;
        return (
          <div
            key={i}
            className={`collapse collapse-arrow border border-base-300 bg-base-100 ${open ? "collapse-open" : "collapse-close"}`}
          >
            <div className="collapse-title flex items-center gap-2 py-1.5 ps-2">
              <button
                type="button"
                aria-expanded={open}
                className="btn btn-ghost btn-sm min-w-0 flex-1 justify-start gap-2 px-1 font-normal"
                onClick={() => setExpanded(open ? null : i)}
              >
                <span className="truncate font-semibold">{m.name.trim() || t("settings.models.unnamed")}</span>
                {m.model && <span className="truncate font-mono text-xs text-base-content/50">{m.model}</span>}
              </button>
              {i === draft.defaultIdx ? (
                <span className="badge badge-primary badge-sm shrink-0">{t("settings.models.default")}</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs shrink-0"
                  onClick={() => onDraft((d) => ({ ...d, defaultIdx: i }))}
                >
                  {t("settings.models.setDefault")}
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-xs shrink-0 text-error" onClick={() => remove(i)}>
                {t("settings.models.delete")}
              </button>
            </div>
            {open && (
              <div className="collapse-content grid grid-cols-2 gap-x-3 gap-y-1">
                <fieldset className="fieldset gap-1.5">
                  <legend className="fieldset-legend">{t("settings.models.name")}</legend>
                  <input
                    className="input input-sm w-full"
                    aria-label={t("settings.models.name")}
                    value={m.name}
                    onChange={(e) => patch(i, { name: e.target.value })}
                  />
                </fieldset>
                <fieldset className="fieldset gap-1.5">
                  <legend className="fieldset-legend">{t("settings.models.provider")}</legend>
                  <select
                    className="select select-sm w-full"
                    aria-label={t("settings.models.provider")}
                    value={m.provider || "anthropic"}
                    onChange={(e) => patch(i, { provider: e.target.value })}
                  >
                    <option value="anthropic">anthropic</option>
                    <option value="openai">openai(Chat Completions)</option>
                    <option value="openai_responses">openai_responses(Responses)</option>
                  </select>
                </fieldset>
                <fieldset className="fieldset col-span-2">
                  <legend className="fieldset-legend">{t("settings.models.baseUrl")}</legend>
                  <input
                    className="input input-sm w-full font-mono text-xs"
                    aria-label={t("settings.models.baseUrl")}
                    placeholder="https://api.example.com"
                    value={m.base_url}
                    onChange={(e) => patch(i, { base_url: e.target.value })}
                  />
                </fieldset>
                <fieldset className="fieldset gap-1.5">
                  <legend className="fieldset-legend">{t("settings.models.apiKey")}</legend>
                  <input
                    className="input input-sm w-full font-mono text-xs"
                    type="password"
                    aria-label={t("settings.models.apiKey")}
                    placeholder="sk-..."
                    value={m.api_key}
                    onChange={(e) => patch(i, { api_key: e.target.value })}
                  />
                </fieldset>
                <fieldset className="fieldset gap-1.5">
                  <legend className="fieldset-legend">{t("settings.models.model")}</legend>
                  <input
                    className="input input-sm w-full font-mono text-xs"
                    aria-label={t("settings.models.model")}
                    value={m.model}
                    onChange={(e) => patch(i, { model: e.target.value })}
                  />
                </fieldset>
                <fieldset className="fieldset gap-1.5">
                  <legend className="fieldset-legend">{t("settings.models.think")}</legend>
                  {/* 缺省("")= 产品默认「低」;off 才是关闭——契约同壳/内核 */}
                  <select
                    className="select select-sm w-full"
                    aria-label={t("settings.models.think")}
                    value={m.think ?? ""}
                    onChange={(e) => patch(i, { think: e.target.value || undefined })}
                  >
                    <option value="">{t("settings.models.think.default")}</option>
                    <option value="off">{t("settings.models.think.off")}</option>
                    <option value="low">{t("settings.models.think.low")}</option>
                    <option value="medium">{t("settings.models.think.medium")}</option>
                    <option value="high">{t("settings.models.think.high")}</option>
                  </select>
                </fieldset>
              </div>
            )}
          </div>
        );
      })}
      <button type="button" className="btn btn-sm btn-outline w-fit" onClick={add}>
        {t("settings.models.add")}
      </button>
    </section>
  );
}
