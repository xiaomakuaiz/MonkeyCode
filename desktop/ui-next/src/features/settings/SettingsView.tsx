// 设置视图:全屏接管主区。左侧窄导航(通用/模型/MCP/运行环境/关于),
// 右侧内容列 + 底部脏状态保存条。
//
// 两类偏好、两条通路:
// - 主题/语言/提示音是"点即生效"偏好,不进保存条(提示音真值在壳,经
//   sound-enabled 事件与托盘/桌宠双向同步);
// - models/mcp/kernel_env 走保存条:save_config 全量写回(表单外字段从载入
//   配置透传),壳保存后重启引擎——重启过程由全局引擎横幅外显,这里不管。
import { useEffect, useMemo, useState } from "react";

import { LOCALES, setLocale, useI18n, type Locale } from "@/lib/i18n";
import {
  getConfig,
  getSoundEnabled,
  listWslDistros,
  onSoundEnabled,
  saveConfig,
  setSoundEnabled,
  type DesktopConfig,
} from "@/lib/ipc/config";
import { isWindowsShell } from "@/lib/ipc/host";
import { inDesktopShell } from "@/lib/ipc/ipc";
import { readTheme, setTheme, THEMES, type Theme } from "@/lib/theme";
import { AccountSection } from "@/features/account/AccountSection";
import { AboutSection } from "./AboutSection";
import { McpSection } from "./McpSection";
import { ModelsSection } from "./ModelsSection";
import {
  buildPayload,
  draftFromConfig,
  payloadEquals,
  validateDraft,
  type DraftError,
  type SettingsDraft,
} from "./settingsForm";

type Section = "general" | "account" | "models" | "mcp" | "env" | "about";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 通用:外观主题 / 语言 / 提示音(仅桌面壳)。 */
function GeneralSection() {
  const { t, locale } = useI18n();
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [soundOn, setSoundOn] = useState(true);

  useEffect(() => {
    if (!inDesktopShell()) return;
    let alive = true;
    void getSoundEnabled().then((on) => {
      if (alive) setSoundOn(on);
    });
    // 托盘勾选项是同一开关的另一入口,订阅广播让两处显示不打架
    const off = onSoundEnabled(setSoundOn);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const pickSound = (next: boolean) => {
    setSoundOn(next); // 乐观置位:壳广播会回来盖一次,失败则回滚
    void setSoundEnabled(next).catch(() => setSoundOn(!next));
  };

  return (
    <section aria-label={t("settings.nav.general")} className="flex max-w-md flex-col gap-3">
      <fieldset className="fieldset gap-1.5">
        <legend className="fieldset-legend">{t("settings.appearance.theme")}</legend>
        <select
          className="select select-sm w-full"
          aria-label={t("settings.appearance.theme")}
          value={theme}
          onChange={(e) => {
            const next = e.target.value as Theme;
            setTheme(next);
            setThemeState(next);
          }}
        >
          {THEMES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </fieldset>
      <fieldset className="fieldset gap-1.5">
        <legend className="fieldset-legend">{t("settings.appearance.language")}</legend>
        <select
          className="select select-sm w-full"
          aria-label={t("settings.appearance.language")}
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {LOCALES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </fieldset>
      {inDesktopShell() && (
        <fieldset className="fieldset gap-1.5">
          <legend className="fieldset-legend">{t("settings.general.sound")}</legend>
          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="toggle toggle-sm"
              aria-label={t("settings.general.sound")}
              checked={soundOn}
              onChange={(e) => pickSound(e.target.checked)}
            />
            <span className="text-xs text-base-content/60">{t("settings.general.soundHint")}</span>
          </label>
        </fieldset>
      )}
      <p className="text-xs text-base-content/50">{t("settings.appearance.hint")}</p>
    </section>
  );
}

/** 运行环境(仅 Windows 壳):内核在本机还是 WSL 发行版内跑。 */
function EnvSection({
  draft,
  distros,
  onDraft,
}: {
  draft: SettingsDraft;
  distros: string[];
  onDraft: (up: (d: SettingsDraft) => SettingsDraft) => void;
}) {
  const { t } = useI18n();
  // 记忆的发行版可能已被卸载:保留为可见项而不是静默改值
  const missing = draft.kernelEnv.startsWith("wsl:") && !distros.includes(draft.kernelEnv.slice(4));
  return (
    <section aria-label={t("settings.nav.env")} className="flex max-w-md flex-col gap-3">
      <fieldset className="fieldset gap-1.5">
        <legend className="fieldset-legend">{t("settings.env.kernel")}</legend>
        <select
          className="select select-sm w-full"
          aria-label={t("settings.env.kernel")}
          value={draft.kernelEnv}
          onChange={(e) => onDraft((d) => ({ ...d, kernelEnv: e.target.value }))}
        >
          <option value="">{t("settings.env.local")}</option>
          {distros.map((d) => (
            <option key={d} value={`wsl:${d}`}>
              WSL · {d}
            </option>
          ))}
          {missing && (
            <option value={draft.kernelEnv}>
              WSL · {draft.kernelEnv.slice(4)}
              {t("settings.env.missing")}
            </option>
          )}
        </select>
        <p className="text-xs text-base-content/50">{t("settings.env.hint")}</p>
      </fieldset>
    </section>
  );
}

export function SettingsView({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>("general");
  const [cfg, setCfg] = useState<DesktopConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [distros, setDistros] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    let alive = true;
    getConfig()
      .then((loaded) => {
        if (!alive || !loaded) return; // null = 浏览器模式,分区各自降级提示
        setCfg(loaded);
        setDraft(draftFromConfig(loaded));
      })
      .catch((e) => {
        if (alive) setLoadError(errMsg(e));
      });
    if (isWindowsShell()) void listWslDistros().then((list) => alive && setDistros(list));
    return () => {
      alive = false;
    };
  }, []);

  // 基线 = 载入配置的归一化载荷(与草稿载荷同构同键序,JSON 串比较即脏判定)
  const baseline = useMemo(() => (cfg ? buildPayload(cfg, draftFromConfig(cfg)) : null), [cfg]);
  const payload = cfg && draft ? buildPayload(cfg, draft) : null;
  const dirty = !!(payload && baseline && !payloadEquals(payload, baseline));

  const updateDraft = (up: (d: SettingsDraft) => SettingsDraft) => {
    setDraft((d) => (d ? up(d) : d));
    setSaveError("");
  };

  const discard = () => {
    if (cfg) setDraft(draftFromConfig(cfg));
    setSaveError("");
  };

  const draftErrText = (e: DraftError): string => {
    switch (e.kind) {
      case "modelName":
        return t("settings.error.modelName");
      case "modelDup":
        return t("settings.error.modelDup", { name: e.name });
      case "mcpName":
        return t("settings.error.mcpName");
      case "mcpDup":
        return t("settings.error.mcpDup", { name: e.name });
      case "mcpIncomplete":
        return t("settings.error.mcpIncomplete", { name: e.name });
    }
  };

  const save = async () => {
    if (!cfg || !draft || !payload) return;
    const invalid = validateDraft(draft);
    if (invalid) {
      setSaveError(draftErrText(invalid));
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      await saveConfig(payload);
      // 保存即真值:壳按载荷写盘(壳自有偏好以磁盘合并,不在本类型内),
      // 表单态重建为已保存形态,保存条随之收起;引擎重启由横幅外显
      setCfg(payload);
      setDraft(draftFromConfig(payload));
    } catch (e) {
      setSaveError(errMsg(e)); // 壳的 Err 是中文,直接外显
    } finally {
      setSaving(false);
    }
  };

  const items: Array<{ id: Section; label: string }> = [
    { id: "general", label: t("settings.nav.general") },
    { id: "account", label: t("settings.nav.account") },
    { id: "models", label: t("settings.nav.models") },
    { id: "mcp", label: t("settings.nav.mcp") },
    ...(isWindowsShell() ? [{ id: "env" as const, label: t("settings.nav.env") }] : []),
    { id: "about", label: t("settings.nav.about") },
  ];

  // 需要壳配置的分区在拿不到配置时的降级提示(浏览器只读 / 载入失败)
  const configGate = !inDesktopShell() ? (
    <div role="alert" className="alert alert-warning alert-soft max-w-md text-xs">
      {t("settings.browserReadonly")}
    </div>
  ) : loadError ? (
    <div role="alert" className="alert alert-error alert-soft max-w-md text-xs">
      {t("settings.loadFailed", { message: loadError })}
    </div>
  ) : null;

  const body = () => {
    switch (section) {
      case "general":
        return <GeneralSection />;
      case "account":
        // 账号分区不吃壳配置(登录态自查、浏览器降级自带),不走 configGate
        return <AccountSection />;
      case "models":
        return draft ? <ModelsSection draft={draft} onDraft={updateDraft} /> : configGate;
      case "mcp":
        return draft ? <McpSection draft={draft} onDraft={updateDraft} /> : configGate;
      case "env":
        return draft ? <EnvSection draft={draft} distros={distros} onDraft={updateDraft} /> : configGate;
      case "about":
        return <AboutSection />;
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-base-100">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-base-300 px-4">
        <h1 className="text-sm font-semibold">{t("settings.title")}</h1>
        <span className="flex-1" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          {t("settings.back")}
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label={t("settings.title")} className="w-40 shrink-0 border-r border-base-300 p-2">
          <ul className="menu w-full gap-0.5 p-0">
            {items.map((it) => (
              <li key={it.id}>
                {/* 当前项激活态统一 bg-primary/10 text-primary(与 rail/侧栏同语言) */}
                <button
                  type="button"
                  className={`transition-colors duration-150 ${section === it.id ? "bg-primary/10 text-primary" : ""}`}
                  aria-current={section === it.id ? "page" : undefined}
                  onClick={() => setSection(it.id)}
                >
                  {it.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 内容列居中收窄:阅读宽度稳定,分区排版不随窗宽漂移 */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">{body()}</div>
          </div>
          {/* 保存条:毛玻璃底贴底 */}
          {dirty && (
            <div className="flex shrink-0 items-center gap-2 border-t border-base-300 bg-base-100/90 px-4 py-2 backdrop-blur">
              <span className="text-xs text-base-content/70">{t("settings.save.dirty")}</span>
              {saveError && (
                <span role="alert" className="min-w-0 truncate text-xs text-error" title={saveError}>
                  {saveError}
                </span>
              )}
              <span className="flex-1" />
              <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={discard}>
                {t("settings.save.discard")}
              </button>
              <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
                {saving && <span className="loading loading-spinner loading-xs" aria-hidden />}
                {t("settings.save.confirm")}
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
