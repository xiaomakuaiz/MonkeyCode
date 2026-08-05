// 全功能 composer:自适应高度输入(IME 守卫)+ 斜杠指令面板 + 附件
// (对话框/粘贴;拖拽由 ChatView 转入 ctl.addFiles)+ 运行条/排队 chip +
// 模型/思考档/权限模式控制。状态机在 useComposer,纯逻辑在 lib/util/slash。
// 发送面契约见 useComposer 文件头;切模型/思考/模式经 lib/ipc/controls
// (session_call),成功不乐观回写——壳会补 model_update / think_update /
// permission_mode_update 帧,ChatState 是唯一真值。
import { ChevronDown, CircleStop, Paperclip, SendHorizontal, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { sessionSetMode, sessionSetModel, sessionSetThink } from "@/lib/ipc/controls";
import { modelsList, type ModelInfo, type SessionMeta } from "@/lib/ipc/sessions";
import { pickAttachmentPaths } from "@/lib/ipc/uploads";
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
import type { ChatState, SlashCommand } from "@/lib/protocol/types";
import { fmtK } from "@/lib/util/fmt";
import { commandText, createImeGuard, cycleIndex, filterCommands, slashQuery } from "@/lib/util/slash";
import { useDismiss } from "@/lib/util/useDismiss";
import type { ComposerCtl } from "./useComposer";

const MAX_TEXTAREA_PX = 160;

// 模型展示投影(短名/档位)统一走 lib/models/modelMenu(protocol/reduce.ts
// 的 model_update 系统行是同一剥名口径,几处必须一致)。

const THINK_LEVELS = ["off", "low", "medium", "high"] as const;
const THINK_KEY: Record<string, MessageKey> = {
  off: "chat.think.off",
  low: "chat.think.low",
  medium: "chat.think.medium",
  high: "chat.think.high",
};
/** 档位副文案(旧 chat.tsx THINK_LEVELS 的 hint 随迁,词条走 i18n)。 */
const THINK_HINT_KEY: Record<string, MessageKey> = {
  off: "chat.think.hint.off",
  low: "chat.think.hint.low",
  medium: "chat.think.hint.medium",
  high: "chat.think.hint.high",
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Composer({
  sessionId,
  state,
  meta,
  ctl,
  onAfterSend,
}: {
  sessionId: string;
  state: ChatState;
  meta: SessionMeta;
  ctl: ComposerCtl;
  onAfterSend?: () => void;
}) {
  const { t } = useI18n();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const imeRef = useRef(createImeGuard());
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [picker, setPicker] = useState<"model" | "think" | null>(null);
  // 模型菜单的过滤词与来源 tab:null =「跟随当前模型的来源」渲染期派生,
  // 仅用户点击才落具体值——models 异步晚到/刷新时不会停在错误来源
  const [modelFilter, setModelFilter] = useState("");
  const [modelTab, setModelTab] = useState<string | null>(null);

  // 模型清单一次拉取(锁定项禁选;浏览器模式为空,触发器仍显当前名)
  useEffect(() => {
    let alive = true;
    void modelsList().then((list) => {
      if (alive && Array.isArray(list)) setModels(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 输入框随内容自适应高度(~160px 封顶,超出内滚)
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [ctl.draft]);

  // ==== 斜杠指令面板(首字符 / 就地补全) ====
  const [slashSuppressed, setSlashSuppressed] = useState(false);
  const [active, setActive] = useState(0);
  const query = slashQuery(ctl.draft);
  const slashOpen = query !== null && !slashSuppressed && state.commands.length > 0;
  const list = useMemo(() => filterCommands(state.commands, query ?? ""), [state.commands, query]);
  const act = Math.min(active, Math.max(0, list.length - 1));
  useEffect(() => setActive(0), [query, state.commands]);
  // `/` 段被清掉 → 解除压制,下次敲 / 照常补全
  useEffect(() => {
    if (query === null) setSlashSuppressed(false);
  }, [query]);

  const pickCommand = (cmd: SlashCommand) => {
    ctl.setDraft(commandText(cmd));
    // 填入的文本自己就是一段 /name,不压住的话面板会立刻回弹匹配自己
    setSlashSuppressed(true);
    taRef.current?.focus();
  };

  // Esc 关闭斜杠面板必须在 window capture 阶段拦截并阻断全局链:审批快捷键
  // 挂在冒泡阶段且 esc 是不可逆的拒绝,面板开着时这一下只能归面板。
  // (模型/思考档 dropdown 的 Esc 在容器 onKeyDown 就地拦截,见 onPickerKeyDown。)
  useEffect(() => {
    if (!slashOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      setSlashSuppressed(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [slashOpen]);

  // ==== 模型 / 思考档 / 权限模式 ====
  const currentModel = state.model || meta.model;
  const modelThink = models.find((m) => m.name === currentModel)?.think;
  const effThink = state.think || meta.think || modelThink || "low";
  const mode = state.permMode || meta.mode || "default";
  const yolo = mode === "yolo";

  // 模型菜单派生(纯逻辑在 lib/models/modelMenu):过滤框在模型多时才有
  // 意义;tab 行只要 ≥2 来源就恒显(它是来源间唯一导航);过滤在 tab 内;
  // 会员 tab 按档位/付费/我的/团队分节,其余来源平铺
  const showModelExtras = shouldShowModelExtras(models.length);
  const modelTabs = modelMenuTabs(models);
  const showModelTabs = modelTabs.length >= 2;
  // 当前来源归一必须 `|| ""`:自定义的 tab key 是空串,`??` 会把它吞成会员
  const currentSource = models.find((m) => m.name === currentModel)?.source || "";
  const wantTab = modelTab ?? currentSource;
  const activeModelTab = modelTabs.some((tab) => tab.key === wantTab) ? wantTab : (modelTabs[0]?.key ?? "");
  const modelTabItems = filterModels(
    models.filter((m) => (m.source || "") === activeModelTab),
    modelFilter,
  );
  const memberSections = activeModelTab === SOURCE_MONKEYCODE ? groupMemberSections(modelTabItems) : null;

  const openModelPicker = () => {
    setModelFilter("");
    setModelTab(null); // 打开时回到「跟随当前模型来源」
    setPicker("model");
  };
  const pickModel = (name: string) => {
    setPicker(null);
    if (!name || name === currentModel) return;
    void sessionSetModel(sessionId, name).catch((e) => {
      ctl.notifyError(t("chat.model.failed", { reason: errText(e) }));
    });
  };
  const pickThink = (level: string) => {
    setPicker(null);
    if (level === effThink) return;
    void sessionSetThink(sessionId, level).catch((e) => {
      ctl.notifyError(t("chat.think.failed", { reason: errText(e) }));
    });
  };
  // 模型条目渲染收口:会员分节内省略档位徽标(节头已表达);locked 条目
  // 灰态禁选,title 说明解锁路径;onPick 必须用原始 name(引擎寻址键)
  const modelItemOf = (m: ModelInfo, noTier = false) => {
    const d = modelDisplay(m);
    return (
      <li key={m.name} className={m.locked ? "menu-disabled" : ""}>
        <button
          type="button"
          disabled={m.locked}
          title={m.locked ? `${stripSourceSuffix(m.name)} · ${t("chat.model.locked")}` : stripSourceSuffix(m.name)}
          aria-current={m.name === currentModel ? "true" : undefined}
          className={`flex items-center gap-2 ${m.name === currentModel ? "menu-active" : ""}`}
          onClick={() => pickModel(m.name)}
        >
          <span className="min-w-0 flex-1 truncate text-xs">{d.label}</span>
          {!noTier && d.tier && <span className="badge badge-ghost badge-xs shrink-0">{d.tier}</span>}
          {m.default && <span className="shrink-0 text-[10px] opacity-50">{t("chat.model.default")}</span>}
        </button>
      </li>
    );
  };
  // 关闭胶水:外点(pointerdown)+ Esc(window capture,截断全局审批链)。
  // 不用 onBlur:WebKitGTK 点按钮不移焦点,relatedTarget 恒 null 会误关
  // (机制注释见 lib/util/useDismiss)
  const thinkBoxRef = useRef<HTMLDivElement | null>(null);
  const modelBoxRef = useRef<HTMLDivElement | null>(null);
  const closePicker = () => setPicker(null);
  useDismiss(picker === "think", thinkBoxRef, closePicker);
  useDismiss(picker === "model", modelBoxRef, closePicker);
  // 权限模式可运行中热切(壳侧支持;yolo 切入时壳自动放行挂起审批)
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const toggleMode = () => {
    const next = modeRef.current === "yolo" ? "default" : "yolo";
    void sessionSetMode(sessionId, next).catch((e) => {
      ctl.notifyError(t("chat.mode.failed", { reason: errText(e) }));
    });
  };
  // ⇧⇥ 与 pill 点击同一动作
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !e.shiftKey) return;
      e.preventDefault();
      toggleMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // toggleMode 经 modeRef 取最新值,处理器可长期持有
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ==== 发送 / 键盘 ====
  const submit = () => {
    if (ctl.send()) onAfterSend?.();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // 斜杠面板优先:↑↓/↩/⇥ 归面板,不落到发送
    if (slashOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive(cycleIndex(act, e.key === "ArrowDown" ? 1 : -1, list.length));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && list.length > 0) {
        // IME 组合态的 ↩ 是选字确认,不是选指令(与发送同一守卫)
        if (e.key === "Enter" && imeRef.current.isImeEnter(e.timeStamp, e.nativeEvent.isComposing)) return;
        e.preventDefault();
        pickCommand(list[act]!);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // IME 组合期(或 WKWebView 上组合刚结束 100ms 窗口内)的 Enter 是选字
      if (imeRef.current.isImeEnter(e.timeStamp, e.nativeEvent.isComposing)) return;
      e.preventDefault();
      submit();
    }
  };

  // 粘贴附件:剪贴板 file item(截图/复制的文件)转附件,文本粘贴不受影响
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      void ctl.addFiles(files);
    }
  };

  const attach = () => {
    void pickAttachmentPaths(t("chat.attachDialogTitle")).then((paths) => {
      if (paths.length) void ctl.addPaths(paths);
    });
  };

  // ==== 运行态文案 ====
  const openPerm = state.items.some((it) => it.kind === "perm" && it.state === "open");
  const anyToolRunning = state.items.some((it) => it.kind === "tool" && it.status === "run");
  const runningLabel = openPerm
    ? t("chat.running.waitPerm")
    : anyToolRunning
      ? t("chat.running.acting")
      : t("chat.running.thinking");
  // 运行条 detail:「第 N 轮 · X tokens」(旧 UI RunningBar 同款;轮数 = user 项计数)
  const roundNo = Math.max(1, state.items.filter((it) => it.kind === "user").length);
  const runningDetail =
    t("chat.running.round", { round: roundNo }) +
    (state.usage && state.usage.used > 0 ? ` · ${fmtK(state.usage.used)} tokens` : "");
  const usagePct =
    state.usage && state.usage.size > 0 ? Math.round((state.usage.used / state.usage.size) * 100) : null;

  return (
    <div className="flex flex-col gap-2">
      {ctl.error && (
        <div role="alert" className="alert alert-error px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate">{ctl.error}</span>
          <button
            type="button"
            aria-label={t("chat.dismiss")}
            className="btn btn-ghost btn-square btn-xs"
            onClick={ctl.dismissError}
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      )}

      {ctl.queued && (
        <div className="alert flex items-center gap-2 px-3 py-1.5 text-xs">
          <span className="badge badge-ghost badge-sm shrink-0">{t("chat.queued")}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{ctl.queued}</span>
          <span className="shrink-0 text-base-content/50">{t("chat.queuedHint")}</span>
          <button
            type="button"
            aria-label={t("chat.queuedCancel")}
            className="btn btn-ghost btn-square btn-xs"
            onClick={ctl.clearQueued}
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      )}

      {/* 输入卡外框:结构线 + 默认底,聚焦时边线加深。斜杠面板是卡内自绘
          浮层(绝对定位,焦点始终留在 textarea)——**不得**给这层卡片挂
          daisyUI dropdown 类:daisyUI 的隐藏规则是后代选择器
          (`.dropdown:not(...) .dropdown-content`),外层 dropdown 处于关态
          时会把嵌套在内的思考/模型菜单一并 display:none(思考菜单弹不出来
          的根因,修复经历见 tasks/lessons.md) */}
      {/* -mx-2.5 光学对齐(旧 UI 出血 10px 随迁):textarea 自带 ~12px 内距,
          硬边卡片与正文同宽会显得输入文字向右缩;向两侧出血后卡内文字
          左缘与对话文字几乎重合,卡片略宽于正文列 */}
      <div className="relative -mx-2.5 flex flex-col rounded-box border border-base-300 bg-base-100 shadow-sm transition-colors focus-within:border-base-content/25">
        {slashOpen && (
          <ul
            role="listbox"
            aria-label={t("chat.slash.label")}
            className="menu absolute start-2 bottom-full z-50 mb-1 max-h-64 w-80 flex-nowrap [&_li]:flex-nowrap overflow-x-hidden overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
          >
            {list.length === 0 && (
              <li className="menu-disabled">
                <span className="text-xs">{t("chat.slash.empty")}</span>
              </li>
            )}
            {list.map((c, i) => (
              <li key={c.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === act}
                  className={`flex items-baseline gap-2 ${i === act ? "menu-active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pickCommand(c)}
                >
                  <span className="font-mono text-xs font-bold">/{c.name}</span>
                  {c.input?.hint && <span className="font-mono text-[10px] opacity-50">{c.input.hint}</span>}
                  {c.description && (
                    <span className="min-w-0 flex-1 truncate text-xs opacity-60">{c.description}</span>
                  )}
                </button>
              </li>
            ))}
            <li className="menu-disabled mt-1 border-t border-base-300">
              <span className="text-[10px]">{t("chat.slash.hint")}</span>
            </li>
          </ul>
        )}

        {/* 运行条:一行紧凑态——spinner + 文案 + 停止 icon 按钮 */}
        {state.running && (
          <div className="flex items-center gap-2 border-b border-base-300 px-3 py-1.5 text-xs">
            <span className="loading loading-spinner loading-xs text-primary" aria-hidden />
            <span className="font-semibold">{runningLabel}</span>
            <span className="truncate text-base-content/40">{runningDetail}</span>
            <span className="flex-1" />
            <button
              type="button"
              aria-label={t("chat.stop")}
              title={t("chat.stop")}
              className="btn btn-ghost btn-square btn-xs text-error"
              onClick={ctl.stop}
            >
              <CircleStop size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        )}

        {(ctl.uploads.length > 0 || ctl.atts.length > 0) && (
          <div className="flex flex-wrap gap-2 px-3 pt-2">
            {ctl.uploads.map((u) => (
              <span key={u.id} className="badge badge-ghost text-xs">
                <span className="loading loading-spinner loading-xs" aria-hidden />
                <span className="max-w-40 truncate">{u.name}</span>
                {u.pct >= 0 && <span className="tabular-nums opacity-60">{u.pct}%</span>}
                {u.cancel && (
                  <button type="button" aria-label={t("chat.uploadCancel")} className="btn btn-ghost btn-circle btn-xs" onClick={u.cancel}>
                    <X size={12} strokeWidth={1.75} aria-hidden />
                  </button>
                )}
              </span>
            ))}
            {ctl.atts.map((a, i) => (
              <span key={a.path} title={a.path} className="badge badge-ghost text-xs">
                <span className="max-w-40 truncate">{a.name}</span>
                <button type="button" aria-label={t("chat.attachRemove")} className="btn btn-ghost btn-circle btn-xs" onClick={() => ctl.removeAtt(i)}>
                  <X size={12} strokeWidth={1.75} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          aria-label={t("chat.composer")}
          className="textarea min-h-10 w-full resize-none border-0 bg-transparent text-sm shadow-none focus:outline-none"
          rows={2}
          placeholder={state.running ? t("chat.composerPlaceholderRunning") : t("chat.composerPlaceholder")}
          value={ctl.draft}
          onChange={(e) => ctl.setDraft(e.target.value)}
          onCompositionEnd={(e) => imeRef.current.markEnd(e.timeStamp)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        {/* min-w-0:长模型名可收缩截断,不得把发送按钮挤出卡片。
            排布随旧 UI 口径:左端 = 模式 pill + 附件入口,右端 = 思考/模型/
            用量/发送(输入侧元信息与动作) */}
        <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
          <button
            type="button"
            title={t("chat.mode.tip")}
            className={`btn btn-xs ${yolo ? "btn-warning btn-soft" : "btn-ghost font-medium text-base-content/70"}`}
            onClick={toggleMode}
          >
            {yolo ? t("chat.mode.yolo") : t("chat.mode.default")}
          </button>
          <button
            type="button"
            aria-label={t("chat.attach")}
            title={t("chat.attachTip")}
            className="btn btn-ghost btn-square btn-xs shrink-0 text-base-content/60"
            onClick={attach}
          >
            <Paperclip size={15} strokeWidth={1.75} aria-hidden />
          </button>
          <span className="min-w-0 flex-1" />

          <div ref={thinkBoxRef} className={`dropdown dropdown-top dropdown-end shrink-0 ${picker === "think" ? "dropdown-open" : ""}`}>
            <button
              type="button"
              disabled={state.running}
              title={state.running ? t("chat.switchWhileRunning") : t("chat.think.tip")}
              className="btn btn-ghost btn-xs font-normal text-base-content/60 disabled:opacity-40"
              onClick={() => setPicker(picker === "think" ? null : "think")}
            >
              {t("chat.think.trigger", { label: t(THINK_KEY[effThink] ?? "chat.think.low") })}
              <ChevronDown size={12} strokeWidth={1.75} aria-hidden className="opacity-60" />
            </button>
            {picker === "think" && (
                <ul
                  aria-label={t("chat.think.label")}
                  className="dropdown-content menu w-52 flex-nowrap [&_li]:flex-nowrap rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
                >
                  {THINK_LEVELS.map((level) => (
                    <li key={level}>
                      <button
                        type="button"
                        aria-current={level === effThink ? "true" : undefined}
                        className={`flex flex-col items-start gap-0 ${level === effThink ? "menu-active" : ""}`}
                        onClick={() => pickThink(level)}
                      >
                        <span className="text-xs">{t(THINK_KEY[level] ?? "chat.think.low")}</span>
                        {/* 档位副文案:一句话讲清速度/深度取舍(旧 UI hint 随迁) */}
                        <span className="text-[10px] opacity-60">{t(THINK_HINT_KEY[level] ?? "chat.think.hint.low")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
            )}
          </div>

          <div ref={modelBoxRef} className={`dropdown dropdown-top dropdown-end min-w-0 shrink ${picker === "model" ? "dropdown-open" : ""}`}>
            <button
              type="button"
              disabled={state.running}
              title={state.running ? t("chat.switchWhileRunning") : t("chat.model.tip")}
              className="btn btn-ghost btn-xs max-w-52 font-normal text-base-content/60 disabled:opacity-40"
              onClick={() => (picker === "model" ? setPicker(null) : openModelPicker())}
            >
              <span className="min-w-0 truncate">
                {modelDisplayByName(models, currentModel).label || t("chat.model.label")}
              </span>
              <ChevronDown size={12} strokeWidth={1.75} aria-hidden className="shrink-0 opacity-60" />
            </button>
            {picker === "model" && (
              // dropdown-content 换 div 外壳:过滤框/来源 tab 固定在顶,
              // 条目列表单独内滚(菜单长了不能把导航滚出视野)
              <div className="dropdown-content flex max-h-72 w-64 flex-col overflow-hidden rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
                {/* 不 autoFocus:打开菜单是「点选」意图,焦点跳进过滤框
                    反而抢走键盘上下文(用户定案) */}
                {showModelExtras && (
                  <input
                    aria-label={t("chat.model.filter")}
                    placeholder={t("chat.model.filter")}
                    className="input input-xs mb-1 w-full shrink-0"
                    value={modelFilter}
                    onChange={(e) => setModelFilter(e.target.value)}
                  />
                )}
                {showModelTabs && (
                  <div role="tablist" aria-label={t("chat.model.sourceTabs")} className="tabs tabs-border tabs-xs shrink-0">
                    {modelTabs.map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        role="tab"
                        aria-selected={tab.key === activeModelTab}
                        className={`tab ${tab.key === activeModelTab ? "tab-active" : ""}`}
                        onClick={() => setModelTab(tab.key)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                )}
                <ul
                  aria-label={t("chat.model.label")}
                  className="menu w-full flex-nowrap [&_li]:flex-nowrap overflow-x-hidden overflow-y-auto p-0"
                >
                  {modelTabItems.length === 0 && (
                    <li className="menu-disabled">
                      <span className="text-xs">
                        {models.length === 0 ? t("chat.model.empty") : t("chat.model.noMatch")}
                      </span>
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
                        ...s.items.map((m) => modelItemOf(m, true)),
                      ])
                    : modelTabItems.map((m) => modelItemOf(m))}
                </ul>
              </div>
            )}
          </div>

          {/* 布局规范:上下文用量是输入侧元信息,归 composer 集群右端。
              形态:daisyUI radial-progress + tooltip(精确 tokens);>85% 用
              功能性状态色示警(旧 ContextRing 的设计,组件官方化) */}
          {usagePct !== null && state.usage && (
            <div
              className="tooltip tooltip-top mx-1 shrink-0"
              data-tip={t("chat.usageTip", {
                used: state.usage.used.toLocaleString(),
                size: state.usage.size.toLocaleString(),
              })}
            >
              <div
                role="progressbar"
                aria-label={t("chat.contextUsage")}
                aria-valuenow={usagePct}
                className={`radial-progress align-middle ${usagePct > 85 ? "text-error" : "text-base-content/40"}`}
                style={{ "--value": Math.min(100, usagePct), "--size": "1rem", "--thickness": "2px" } as CSSProperties}
              />
            </div>
          )}
          <button
            type="button"
            aria-label={t("chat.send")}
            title={t("chat.sendTip")}
            className="btn btn-primary btn-square btn-sm shrink-0"
            disabled={!ctl.draft.trim() && ctl.atts.length === 0}
            onClick={submit}
          >
            <SendHorizontal size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
