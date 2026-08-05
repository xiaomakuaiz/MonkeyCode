// 轻量下拉选择器三件套:会话 composer 与新建任务页共用同一形态
// (btn-ghost 文字触发器 + rounded-box 菜单),模型选择的过滤框/来源 tab/
// 会员分节逻辑收口在此,两处不再各写一份。
// - ModelMenu:模型切换(过滤/来源 tab/会员分节/锁定灰态,纯逻辑在
//   lib/models/modelMenu);
// - ThinkMenu:思考深度(档位 + hint 副文案;levels 可配,新建任务页多一档
//   ""=跟随模型默认);
// - OptionMenu:通用平铺单选(云端任务的宿主机/镜像等)。
// 关闭胶水统一 useDismiss(外点 pointerdown + Esc;不用 onBlur,WebKitGTK
// 点按钮不移焦点会误关)。
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import type { ModelInfo } from "@/lib/ipc/sessions";
import {
  filterModels,
  groupMemberSections,
  modelDisplay,
  modelDisplayByName,
  modelMenuTabs,
  shouldShowModelExtras,
  stripSourceSuffix,
  SOURCE_MONKEYCODE,
} from "@/lib/models/modelMenu";
import { useDismiss } from "@/lib/util/useDismiss";

export const THINK_KEY: Record<string, MessageKey> = {
  "": "create.think.default",
  off: "chat.think.off",
  low: "chat.think.low",
  medium: "chat.think.medium",
  high: "chat.think.high",
};
/** 档位副文案(一句话讲清速度/深度取舍);""=跟随默认无副文案。 */
export const THINK_HINT_KEY: Partial<Record<string, MessageKey>> = {
  off: "chat.think.hint.off",
  low: "chat.think.hint.low",
  medium: "chat.think.hint.medium",
  high: "chat.think.hint.high",
};
export const THINK_LEVELS = ["off", "low", "medium", "high"] as const;

/** 触发器公共形态:幽灵小按钮 + 旋转箭头。 */
function Trigger({
  open,
  disabled,
  title,
  ariaLabel,
  className,
  onToggle,
  children,
}: {
  open: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  className?: string;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={open}
      className={`btn btn-ghost btn-xs font-normal text-base-content/60 disabled:opacity-40 ${className ?? ""}`}
      onClick={onToggle}
    >
      {children}
      <ChevronDown size={12} strokeWidth={1.75} aria-hidden className="shrink-0 opacity-60" />
    </button>
  );
}

export function ModelMenu({
  models,
  current,
  onPick,
  disabled = false,
  title,
  ariaLabel,
  align = "end",
}: {
  models: ModelInfo[];
  current: string;
  /** 选中回调(菜单已自关);同名/空名的去重守卫由调用方决定 */
  onPick: (name: string) => void;
  disabled?: boolean;
  title?: string;
  /** 触发器 aria-label;不传则可及名 = 当前模型展示名(composer 契约) */
  ariaLabel?: string;
  align?: "start" | "end";
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismiss(open, boxRef, () => setOpen(false));

  // 模型菜单派生(纯逻辑在 lib/models/modelMenu):过滤框在模型多时才有
  // 意义;tab 行只要 ≥2 来源就恒显(它是来源间唯一导航);过滤在 tab 内;
  // 会员 tab 按档位/付费/我的/团队分节,其余来源平铺
  const showExtras = shouldShowModelExtras(models.length);
  const tabs = modelMenuTabs(models);
  const showTabs = tabs.length >= 2;
  // 当前来源归一必须 `|| ""`:自定义的 tab key 是空串,`??` 会把它吞成会员
  const currentSource = models.find((m) => m.name === current)?.source || "";
  const wantTab = tab ?? currentSource;
  const activeTab = tabs.some((it) => it.key === wantTab) ? wantTab : (tabs[0]?.key ?? "");
  const tabItems = filterModels(
    models.filter((m) => (m.source || "") === activeTab),
    filter,
  );
  const memberSections = activeTab === SOURCE_MONKEYCODE ? groupMemberSections(tabItems) : null;

  const openMenu = () => {
    setFilter("");
    setTab(null); // 打开时回到「跟随当前模型来源」
    setOpen(true);
  };
  const pick = (name: string) => {
    setOpen(false);
    onPick(name);
  };
  // 模型条目渲染收口:会员分节内省略档位徽标(节头已表达);locked 条目
  // 灰态禁选,title 说明解锁路径;onPick 必须用原始 name(引擎寻址键)
  const itemOf = (m: ModelInfo, noTier = false) => {
    const d = modelDisplay(m);
    return (
      <li key={m.name} className={m.locked ? "menu-disabled" : ""}>
        <button
          type="button"
          disabled={m.locked}
          title={m.locked ? `${stripSourceSuffix(m.name)} · ${t("chat.model.locked")}` : stripSourceSuffix(m.name)}
          aria-current={m.name === current ? "true" : undefined}
          className={`flex items-center gap-2 ${m.name === current ? "menu-active" : ""}`}
          onClick={() => pick(m.name)}
        >
          <span className="min-w-0 flex-1 truncate text-xs">{d.label}</span>
          {!noTier && d.tier && <span className="badge badge-ghost badge-xs shrink-0">{d.tier}</span>}
          {m.default && <span className="shrink-0 text-[10px] opacity-50">{t("chat.model.default")}</span>}
        </button>
      </li>
    );
  };

  return (
    <div
      ref={boxRef}
      className={`dropdown dropdown-top min-w-0 shrink ${align === "end" ? "dropdown-end" : ""} ${open ? "dropdown-open" : ""}`}
    >
      <Trigger
        open={open}
        disabled={disabled}
        title={title}
        ariaLabel={ariaLabel}
        className="max-w-52"
        onToggle={() => (open ? setOpen(false) : openMenu())}
      >
        <span className="min-w-0 truncate">{modelDisplayByName(models, current).label || t("chat.model.label")}</span>
      </Trigger>
      {open && (
        // dropdown-content 换 div 外壳:过滤框/来源 tab 固定在顶,
        // 条目列表单独内滚(菜单长了不能把导航滚出视野)
        <div className="dropdown-content flex max-h-72 w-64 flex-col overflow-hidden rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
          {/* 不 autoFocus:打开菜单是「点选」意图,焦点跳进过滤框
              反而抢走键盘上下文(用户定案) */}
          {showExtras && (
            <input
              aria-label={t("chat.model.filter")}
              placeholder={t("chat.model.filter")}
              className="input input-xs mb-1 w-full shrink-0"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {showTabs && (
            <div role="tablist" aria-label={t("chat.model.sourceTabs")} className="tabs tabs-border tabs-xs shrink-0">
              {tabs.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  role="tab"
                  aria-selected={it.key === activeTab}
                  className={`tab ${it.key === activeTab ? "tab-active" : ""}`}
                  onClick={() => setTab(it.key)}
                >
                  {it.label}
                </button>
              ))}
            </div>
          )}
          <ul
            aria-label={t("chat.model.label")}
            className="menu w-full flex-nowrap [&_li]:flex-nowrap overflow-x-hidden overflow-y-auto p-0"
          >
            {tabItems.length === 0 && (
              <li className="menu-disabled">
                <span className="text-xs">{models.length === 0 ? t("chat.model.empty") : t("chat.model.noMatch")}</span>
              </li>
            )}
            {/* 会员 tab:档位/付费/我的/团队分节,节头恒显(每节都承载
                语义,条目内省略档位徽标);其余来源平铺 */}
            {memberSections !== null
              ? memberSections.map((s) => [
                  <li key={`${s.label}-title`} className="menu-title flex flex-row items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    {s.badge && <span className="shrink-0 text-[10px] font-normal">{s.badge}</span>}
                  </li>,
                  ...s.items.map((m) => itemOf(m, true)),
                ])
              : tabItems.map((m) => itemOf(m))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ThinkMenu({
  current,
  display,
  onPick,
  levels = [...THINK_LEVELS],
  disabled = false,
  title,
  ariaLabel,
  align = "end",
}: {
  /** 菜单选中态(新建任务页可为 ""=跟随模型默认) */
  current: string;
  /** 触发器展示档(生效档;缺省同 current) */
  display?: string;
  onPick: (level: string) => void;
  levels?: string[];
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  align?: "start" | "end";
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismiss(open, boxRef, () => setOpen(false));
  const shown = display ?? current;
  return (
    <div
      ref={boxRef}
      className={`dropdown dropdown-top shrink-0 ${align === "end" ? "dropdown-end" : ""} ${open ? "dropdown-open" : ""}`}
    >
      <Trigger open={open} disabled={disabled} title={title} ariaLabel={ariaLabel} onToggle={() => setOpen(!open)}>
        {t("chat.think.trigger", { label: t(THINK_KEY[shown] ?? "chat.think.low") })}
      </Trigger>
      {open && (
        <ul
          aria-label={t("chat.think.label")}
          className="dropdown-content menu w-52 flex-nowrap [&_li]:flex-nowrap rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
        >
          {levels.map((level) => {
            const hintKey = THINK_HINT_KEY[level];
            return (
              <li key={level}>
                <button
                  type="button"
                  aria-current={level === current ? "true" : undefined}
                  className={`flex flex-col items-start gap-0 ${level === current ? "menu-active" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    onPick(level);
                  }}
                >
                  <span className="text-xs">{t(THINK_KEY[level] ?? "chat.think.low")}</span>
                  {/* 档位副文案:一句话讲清速度/深度取舍(旧 UI hint 随迁) */}
                  {hintKey && <span className="text-[10px] opacity-60">{t(hintKey)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export interface OptionItem {
  value: string;
  label: string;
  disabled?: boolean;
}

/** 通用单选菜单(云端任务的模型/宿主机/镜像等):形态同上;平铺给 options,
 * 分组给 sections(节头 = menu-title,同 ModelMenu 会员分节)。 */
export function OptionMenu({
  options,
  sections,
  value,
  onPick,
  ariaLabel,
  triggerLabel,
  disabled = false,
  title,
  align = "start",
}: {
  options?: OptionItem[];
  sections?: Array<{ key: string; label: string; badge?: string; options: OptionItem[] }>;
  value: string;
  onPick: (value: string) => void;
  /** 触发器与菜单列表共用的可及名(role 区分,查询不歧义) */
  ariaLabel: string;
  /** 触发器展示文案;缺省 = 选中项 label(分组场景可传「组名 / 条目名」) */
  triggerLabel?: string;
  disabled?: boolean;
  title?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDismiss(open, boxRef, () => setOpen(false));
  const flat = options ?? sections?.flatMap((s) => s.options) ?? [];
  const currentLabel = triggerLabel ?? flat.find((o) => o.value === value)?.label ?? ariaLabel;
  const itemOf = (o: OptionItem) => (
    <li key={o.value} className={o.disabled ? "menu-disabled" : ""}>
      <button
        type="button"
        disabled={o.disabled}
        aria-current={o.value === value ? "true" : undefined}
        className={o.value === value ? "menu-active" : ""}
        onClick={() => {
          setOpen(false);
          onPick(o.value);
        }}
      >
        <span className="min-w-0 flex-1 truncate text-xs">{o.label}</span>
      </button>
    </li>
  );
  return (
    <div
      ref={boxRef}
      className={`dropdown dropdown-top min-w-0 shrink ${align === "end" ? "dropdown-end" : ""} ${open ? "dropdown-open" : ""}`}
    >
      <Trigger
        open={open}
        disabled={disabled}
        title={title ?? currentLabel}
        ariaLabel={ariaLabel}
        className="max-w-48"
        onToggle={() => setOpen(!open)}
      >
        <span className="min-w-0 truncate">{currentLabel}</span>
      </Trigger>
      {open && (
        <ul
          aria-label={ariaLabel}
          className="dropdown-content menu max-h-72 w-64 flex-nowrap [&_li]:flex-nowrap overflow-x-hidden overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
        >
          {sections
            ? sections.map((s) => [
                <li key={`${s.key}-title`} className="menu-title flex flex-row items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate">{s.label}</span>
                  {s.badge && <span className="shrink-0 text-[10px] font-normal">{s.badge}</span>}
                </li>,
                ...s.options.map(itemOf),
              ])
            : flat.map(itemOf)}
        </ul>
      )}
    </div>
  );
}
