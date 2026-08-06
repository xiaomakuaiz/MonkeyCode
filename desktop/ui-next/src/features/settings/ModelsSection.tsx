// 模型列表编辑:行内受控展开(一次一行),增删改与"设为默认"。
// 表单只呈现核心字段(名称/协议/接口地址/API Key/模型标识/思考深度);
// 高级字段(context_window/max_output/vision)与同步标记(source/locked/owner)
// 留在草稿对象里随保存透传,不因编辑丢失。
// 展示口径:行标题经 modelDisplay 剥来源后缀/会员档位前缀(落盘名是引擎
// 寻址键,任何展示面都必须剥;编辑表单里的「名称」字段仍是原始键);
// 列表按来源分组(会员→百智云→自定义,modelSourceRank 单一出处),全部
// 为手工条目时不出组头。
import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";

import { useI18n } from "@/lib/i18n";
import type { HostModel } from "@/lib/ipc/config";
import type { ModelInfo } from "@/lib/ipc/sessions";
import { groupMemberSections, modelDisplay, modelSourceRank, SOURCE_BAIZHI, SOURCE_MONKEYCODE } from "@/lib/models/modelMenu";
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
  // 组折叠(旧工程 Section 折叠开关的等价物):默认全展开,点组头收起
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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

  // 来源分组(保留原始下标:展开/删改/设默认全部按扁平数组下标寻址)
  const groupMap = new Map<string, { key: string; label: string; rank: number; items: Array<{ m: HostModel; i: number }> }>();
  draft.models.forEach((m, i) => {
    const key = m.source || "";
    let g = groupMap.get(key);
    if (!g) {
      const label =
        key === SOURCE_MONKEYCODE
          ? t("model.source.member")
          : key === SOURCE_BAIZHI
            ? t("model.source.baizhi")
            : key || t("model.source.custom");
      g = { key, label, rank: modelSourceRank(m.source), items: [] };
      groupMap.set(key, g);
    }
    g.items.push({ m, i });
  });
  const groups = [...groupMap.values()].sort((a, b) => a.rank - b.rank);
  const showGroups = groups.length > 1 || groups.some((g) => g.key !== "");

  // 行 = daisyUI list-row。契约(用户定案 2026-08-06):
  // - 会员条目(source=monkeycode)只读不可展开——配置随同步整组更新,表单
  //   里没有可改的东西;百智云/手工条目可展开编辑;
  // - 同步条目(会员/百智云)只有「设为默认」,删除只给自定义条目(同步组
  //   的成员由云端管理,本地删了重同步也会回来,徒增困惑);
  // - 动作 hover 才显现(每行常驻是视觉噪音);锁定条目不物化进引擎,
  //   不给「设为默认」;
  // - 同步条目不露 wire 串(与名称/档位节头重复);手工条目保留 model 标识
  //   (名称是用户起的别名,标识才是身份)。noTier:会员组按档位分节后节头
  //   已表达档位,行内不再重复贴徽标
  const row = (m: HostModel, i: number, noTier = false) => {
    const managed = m.source === SOURCE_MONKEYCODE;
    const open = expanded === i && !managed;
    const d = modelDisplay({ name: m.name, model: m.model, source: m.source });
    const nameBody = (
      <>
        {/* 行主文本 = 应用基准 14px 常规(与侧栏/菜单行同级),不加粗:
            名称的主导地位靠 wire 串的灰色等宽小字衬出,不靠字重 */}
        <span className={`truncate ${m.locked ? "text-base-content/50" : ""}`}>
          {d.label.trim() || t("settings.models.unnamed")}
        </span>
        {!noTier && d.tier && <span className="badge badge-ghost badge-sm shrink-0">{d.tier}</span>}
        {m.locked && <span className="badge badge-warning badge-soft badge-sm shrink-0">{t("settings.models.lockedBadge")}</span>}
        {!m.source && m.model && <span className="min-w-0 truncate font-mono text-xs text-base-content/50">{m.model}</span>}
      </>
    );
    return (
          <li key={i} className="flex flex-col">
            {/* 整行是展开热区(旧工程口径);动作钮截断冒泡。箭头恒在行尾,
                hover 动作在名称与箭头之间滑入,不推挤箭头 */}
            <div
              className={`group list-row items-center gap-2 rounded-none px-4 py-2 transition-colors hover:bg-base-200/40 ${managed ? "" : "cursor-pointer"}`}
              onClick={managed ? undefined : () => setExpanded(open ? null : i)}
            >
              {managed ? (
                <span className="list-col-grow flex min-w-0 items-center gap-2" title={m.name.trim() || undefined}>
                  {nameBody}
                </span>
              ) : (
                // 无独立 onClick:点击冒泡到行级热区,一次翻转(role/aria 仍在)
                <button
                  type="button"
                  aria-expanded={open}
                  title={m.name.trim() || undefined}
                  className="list-col-grow flex min-w-0 cursor-pointer items-center gap-2 text-start"
                >
                  {nameBody}
                </button>
              )}
              {i === draft.defaultIdx ? (
                <span className="badge badge-primary badge-sm shrink-0">{t("settings.models.default")}</span>
              ) : (
                !m.locked && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs shrink-0 text-base-content/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDraft((d) => ({ ...d, defaultIdx: i }));
                    }}
                  >
                    {t("settings.models.setDefault")}
                  </button>
                )
              )}
              {!m.source && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs shrink-0 text-base-content/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-error"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(i);
                  }}
                >
                  {t("settings.models.delete")}
                </button>
              )}
              {!managed && (
                <ChevronDown
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden
                  className={`shrink-0 text-base-content/40 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
                />
              )}
            </div>
            {open && (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-base-300 px-4 pt-2 pb-4">
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
          </li>
        );
  };

  return (
    <section aria-label={t("settings.nav.models")} className="flex flex-col gap-2">
      {draft.models.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-box border border-dashed border-base-300 px-6 py-10">
          <p className="text-center text-xs text-base-content/50">{t("settings.models.empty")}</p>
          <button type="button" className="btn btn-sm" onClick={add}>
            <Plus size={14} strokeWidth={2} aria-hidden />
            {t("settings.models.add")}
          </button>
        </div>
      )}
      {groups.map((g) => {
        // 会员组按档位/来源分节(基础/专业/旗舰/付费/我的/团队,与模型菜单
        // 同一 groupMemberSections 口径):节头表达档位,行内免重复贴徽标。
        // 结构性转型(HostModel ⊂ ModelInfo 形状,default 可缺省),节内条目
        // 经对象同一性映回扁平数组下标
        const memberSections =
          g.key === SOURCE_MONKEYCODE
            ? groupMemberSections(g.items.map(({ m }) => m) as unknown as ModelInfo[])
            : null;
        const indexOf = new Map(g.items.map(({ m, i }) => [m as unknown as ModelInfo, i]));
        const groupOpen = !collapsedGroups.has(g.key);
        return (
          <div key={g.key || "custom"} className="flex flex-col gap-1.5">
            {/* 组头即折叠开关(旧工程 Section 同款交互):箭头 + 组名 + 计数 */}
            {showGroups && (
              <button
                type="button"
                aria-expanded={groupOpen}
                className="mt-1 flex w-fit cursor-pointer items-center gap-1.5 px-1 text-xs font-bold text-base-content/60 transition-colors hover:text-base-content"
                onClick={() => toggleGroup(g.key)}
              >
                <ChevronDown
                  size={13}
                  strokeWidth={2}
                  aria-hidden
                  className={`shrink-0 transition-transform duration-150 ${groupOpen ? "" : "-rotate-90"}`}
                />
                {g.label}
                <span className="font-normal text-base-content/40">{g.items.length}</span>
              </button>
            )}
            {/* 组 = 一个 list 容器,行间分隔线;不再每行一个独立小盒子 */}
            {groupOpen && (
              <ul className="list divide-y divide-base-300 rounded-box border border-base-300 bg-base-100">
                {memberSections
                  ? memberSections.map((s) => [
                      <li
                        key={`${s.label}-title`}
                        className="flex items-baseline gap-2 px-4 pt-2.5 pb-1 text-xs font-bold tracking-wide text-base-content/40"
                      >
                        {s.label}
                        {s.badge && <span className="font-normal">{s.badge}</span>}
                      </li>,
                      ...s.items.map((m) => row(m as unknown as HostModel, indexOf.get(m)!, true)),
                    ])
                  : g.items.map(({ m, i }) => row(m, i))}
              </ul>
            )}
          </div>
        );
      })}
      {draft.models.length > 0 && (
        <button type="button" className="btn btn-sm btn-outline w-fit" onClick={add}>
          <Plus size={14} strokeWidth={2} aria-hidden />
          {t("settings.models.add")}
        </button>
      )}
    </section>
  );
}
