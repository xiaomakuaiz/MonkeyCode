// 设置视图:全屏接管主区。左侧窄导航(通用/模型/MCP/运行环境/关于),
// 右侧内容列 + 底部脏状态保存条。
//
// 两类偏好、两条通路:
// - 主题/语言/提示音是"点即生效"偏好,不进保存条(提示音真值在壳,经
//   sound-enabled 事件与托盘/桌宠双向同步);
// - models/mcp/kernel_env 走保存条:save_config 全量写回(表单外字段从载入
//   配置透传),壳保存后重启引擎——重启过程由全局引擎横幅外显,这里不管。
import { Brain, Info, Server, SlidersHorizontal, SquareTerminal, UserRound, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
import type { BaizhiSyncResult, McModelsSyncResult } from "@/lib/ipc/account";
import { SOURCE_BAIZHI, SOURCE_MONKEYCODE } from "@/lib/models/modelMenu";
import {
  buildPayload,
  draftFromConfig,
  mergeSyncedMcps,
  mergeSyncedModels,
  payloadEquals,
  validateDraft,
  type DraftError,
  type SettingsDraft,
} from "./settingsForm";

type Section = "general" | "account" | "models" | "mcp" | "env" | "about";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 设置行:左侧名称+说明、右侧控件,行间分隔线成组——桌面设置页惯例。 */
function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-xs leading-relaxed text-base-content/50">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

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
    <section aria-label={t("settings.nav.general")} className="flex flex-col gap-2">
      <div className="divide-y divide-base-300 rounded-box border border-base-300">
        <SettingRow label={t("settings.appearance.theme")}>
          <select
            className="select select-sm w-48 shrink-0"
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
        </SettingRow>
        <SettingRow label={t("settings.appearance.language")}>
          <select
            className="select select-sm w-48 shrink-0"
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
        </SettingRow>
        {inDesktopShell() && (
          <SettingRow label={t("settings.general.sound")} hint={t("settings.general.soundHint")}>
            <input
              type="checkbox"
              className="toggle toggle-sm shrink-0"
              aria-label={t("settings.general.sound")}
              checked={soundOn}
              onChange={(e) => pickSound(e.target.checked)}
            />
          </SettingRow>
        )}
      </div>
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
    <section aria-label={t("settings.nav.env")} className="flex flex-col gap-2">
      <div className="rounded-box border border-base-300">
        <SettingRow label={t("settings.env.kernel")} hint={t("settings.env.hint")}>
          <select
            className="select select-sm w-48 shrink-0"
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
        </SettingRow>
      </div>
    </section>
  );
}

export function SettingsView({ onClose }: { onClose: () => void }) {
  // 桌面客户端惯例:Esc 离开设置视图(capture 消费,不落到下层快捷键)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

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

  // 账号页同步结果并入草稿(整组替换,纯逻辑在 settingsForm):不自动保存
  // ——保存会重启引擎,这里看不到是否有任务在跑,交给保存条让用户择机确认;
  // 跳过名单(跨组撞名先到先得)返回给账号卡就地外显。
  // 基准取 ref 而非闭包:同步是"发请求→等数秒→回来再合并",登录顺带的
  // 双路同步(百智云+会员)先后到达,拿闭包里的旧草稿会把先到的一路抹掉
  const draftRef = useRef<SettingsDraft | null>(null);
  draftRef.current = draft;
  const applySync = (r: BaizhiSyncResult | McModelsSyncResult): { skipped: string[] } | undefined => {
    let next = draftRef.current;
    if (!next) return undefined;
    const fromBaizhi = "mcp_servers" in r;
    const source = r.models[0]?.source || (fromBaizhi ? SOURCE_BAIZHI : SOURCE_MONKEYCODE);
    let skipped: string[] = [];
    const merged = mergeSyncedModels(next, r.models, source);
    if (merged) {
      next = merged.draft;
      skipped = merged.skipped;
    }
    if (fromBaizhi) next = mergeSyncedMcps(next, r.mcp_servers);
    draftRef.current = next;
    setDraft(next);
    setSaveError("");
    return { skipped };
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

  const items: Array<{ id: Section; label: string; desc: string; icon: LucideIcon }> = [
    { id: "general", label: t("settings.nav.general"), desc: t("settings.desc.general"), icon: SlidersHorizontal },
    { id: "account", label: t("settings.nav.account"), desc: t("settings.desc.account"), icon: UserRound },
    { id: "models", label: t("settings.nav.models"), desc: t("settings.desc.models"), icon: Brain },
    { id: "mcp", label: t("settings.nav.mcp"), desc: t("settings.desc.mcp"), icon: Server },
    ...(isWindowsShell()
      ? [{ id: "env" as const, label: t("settings.nav.env"), desc: t("settings.desc.env"), icon: SquareTerminal }]
      : []),
    { id: "about", label: t("settings.nav.about"), desc: t("settings.desc.about"), icon: Info },
  ];
  const active = items.find((it) => it.id === section);

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
        // 账号分区不吃壳配置(登录态自查、浏览器降级自带),不走 configGate;
        // 同步结果经 applySync 并入模型/MCP 草稿
        return <AccountSection onSyncResult={applySync} />;
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
      <header data-tauri-drag-region="" data-view-header="" className="flex h-13 shrink-0 items-center gap-2 border-b border-base-300 px-4">
        <h1 data-tauri-drag-region="" className="text-sm font-semibold">{t("settings.title")}</h1>
        <span data-tauri-drag-region="" className="flex-1" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          {t("settings.back")}
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label={t("settings.title")} className="w-44 shrink-0 border-r border-base-300 p-2">
          <ul className="menu w-full gap-0.5 p-0">
            {items.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  className={`gap-2.5 transition-colors duration-150 ${section === it.id ? "menu-active" : ""}`}
                  aria-current={section === it.id ? "page" : undefined}
                  onClick={() => setSection(it.id)}
                >
                  <it.icon size={15} strokeWidth={1.75} aria-hidden className="text-base-content/60" />
                  {it.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 内容列居中收窄:阅读宽度稳定,分区排版不随窗宽漂移 */}
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-5">
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
              {/* 分区头:大标题+一句话说明(对齐旧工程设置屏的标题层级) */}
              <header className="flex flex-col gap-1">
                <h2 className="text-xl font-bold">{active?.label}</h2>
                <p className="text-xs text-base-content/60">{active?.desc}</p>
              </header>
              {body()}
            </div>
          </div>
          {/* 保存条:结构线贴底 */}
          {dirty && (
            <div className="flex shrink-0 items-center gap-2 border-t border-base-300 bg-base-100 px-4 py-2">
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
