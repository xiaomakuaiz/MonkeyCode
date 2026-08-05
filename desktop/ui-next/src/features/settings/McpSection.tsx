// MCP 服务器编辑:与模型列表同一套行内展开交互与脏状态(同一份草稿)。
// 条目形态 = settingsForm.McpEntry(与内核 mcp.json 的 mcpServers 同构),
// 表单外字段进 extra 随保存透传。
import { Plus } from "lucide-react";
import { useState } from "react";

import { useI18n } from "@/lib/i18n";
import { emptyMcp, type McpEntry, type SettingsDraft } from "./settingsForm";

export function McpSection({
  draft,
  onDraft,
}: {
  draft: SettingsDraft;
  onDraft: (up: (d: SettingsDraft) => SettingsDraft) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<number | null>(null);

  const patch = (i: number, p: Partial<McpEntry>) =>
    onDraft((d) => ({ ...d, mcps: d.mcps.map((m, j) => (j === i ? { ...m, ...p } : m)) }));

  const remove = (i: number) => {
    onDraft((d) => ({ ...d, mcps: d.mcps.filter((_, j) => j !== i) }));
    setExpanded(null);
  };

  const add = () => {
    setExpanded(draft.mcps.length);
    onDraft((d) => ({ ...d, mcps: [...d.mcps, emptyMcp()] }));
  };

  return (
    <section aria-label={t("settings.nav.mcp")} className="flex flex-col gap-2">
      {draft.mcps.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-box border border-dashed border-base-300 px-6 py-10">
          <p className="text-center text-xs text-base-content/50">{t("settings.mcp.empty")}</p>
          <button type="button" className="btn btn-sm" onClick={add}>
            <Plus size={14} strokeWidth={2} aria-hidden />
            {t("settings.mcp.add")}
          </button>
        </div>
      )}
      {draft.mcps.map((m, i) => {
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
                <span className="badge badge-ghost badge-sm shrink-0">{m.type}</span>
              </button>
              <button type="button" className="btn btn-ghost btn-xs shrink-0 text-error" onClick={() => remove(i)}>
                {t("settings.mcp.delete")}
              </button>
            </div>
            {open && (
              <div className="collapse-content grid grid-cols-2 gap-x-3 gap-y-1">
                <fieldset className="fieldset gap-1.5">
                  <legend className="fieldset-legend">{t("settings.mcp.name")}</legend>
                  <input
                    className="input input-sm w-full font-mono text-xs"
                    aria-label={t("settings.mcp.name")}
                    value={m.name}
                    onChange={(e) => patch(i, { name: e.target.value })}
                  />
                </fieldset>
                <fieldset className="fieldset gap-1.5">
                  <legend className="fieldset-legend">{t("settings.mcp.type")}</legend>
                  <select
                    className="select select-sm w-full"
                    aria-label={t("settings.mcp.type")}
                    value={m.type}
                    onChange={(e) => patch(i, { type: e.target.value === "stdio" ? "stdio" : "http" })}
                  >
                    <option value="http">HTTP</option>
                    <option value="stdio">stdio</option>
                  </select>
                </fieldset>
                {m.type === "http" ? (
                  <fieldset className="fieldset col-span-2">
                    <legend className="fieldset-legend">{t("settings.mcp.url")}</legend>
                    <input
                      className="input input-sm w-full font-mono text-xs"
                      aria-label={t("settings.mcp.url")}
                      placeholder="https://example.com/mcp"
                      value={m.url}
                      onChange={(e) => patch(i, { url: e.target.value })}
                    />
                  </fieldset>
                ) : (
                  <>
                    <fieldset className="fieldset gap-1.5">
                      <legend className="fieldset-legend">{t("settings.mcp.command")}</legend>
                      <input
                        className="input input-sm w-full font-mono text-xs"
                        aria-label={t("settings.mcp.command")}
                        placeholder="npx"
                        value={m.command}
                        onChange={(e) => patch(i, { command: e.target.value })}
                      />
                    </fieldset>
                    <fieldset className="fieldset gap-1.5">
                      <legend className="fieldset-legend">{t("settings.mcp.args")}</legend>
                      <input
                        className="input input-sm w-full font-mono text-xs"
                        aria-label={t("settings.mcp.args")}
                        value={m.args}
                        onChange={(e) => patch(i, { args: e.target.value })}
                      />
                    </fieldset>
                  </>
                )}
                <fieldset className="fieldset col-span-2">
                  <legend className="fieldset-legend">
                    {m.type === "http" ? t("settings.mcp.headers") : t("settings.mcp.env")}
                  </legend>
                  <textarea
                    className="textarea textarea-sm w-full font-mono text-xs"
                    rows={3}
                    aria-label={m.type === "http" ? t("settings.mcp.headers") : t("settings.mcp.env")}
                    value={m.kv}
                    onChange={(e) => patch(i, { kv: e.target.value })}
                  />
                </fieldset>
              </div>
            )}
          </div>
        );
      })}
      {draft.mcps.length > 0 && (
        <button type="button" className="btn btn-sm btn-outline w-fit" onClick={add}>
          <Plus size={14} strokeWidth={2} aria-hidden />
          {t("settings.mcp.add")}
        </button>
      )}
    </section>
  );
}
