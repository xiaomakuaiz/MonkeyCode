// 全功能 composer:自适应高度输入(IME 守卫)+ 斜杠指令面板 + 附件
// (对话框/粘贴;拖拽由 ChatView 转入 ctl.addFiles)+ 运行条/排队 chip +
// 模型/思考档/权限模式控制。状态机在 useComposer,纯逻辑在 lib/util/slash。
// 发送面契约见 useComposer 文件头;切模型/思考/模式经 lib/ipc/controls
// (session_call),成功不乐观回写——壳会补 model_update / think_update /
// permission_mode_update 帧,ChatState 是唯一真值。
import { CircleStop, Paperclip, SendHorizontal, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { sessionSetMode, sessionSetModel, sessionSetThink } from "@/lib/ipc/controls";
import { modelsList, type ModelInfo, type SessionMeta } from "@/lib/ipc/sessions";
import { pickAttachmentPaths } from "@/lib/ipc/uploads";
import type { ChatState, SlashCommand } from "@/lib/protocol/types";
import { commandText, createImeGuard, cycleIndex, filterCommands, slashQuery } from "@/lib/util/slash";
import type { ComposerCtl } from "./useComposer";

const MAX_TEXTAREA_PX = 160;

/** 模型展示短名:剥 @来源#配置id 寻址后缀与会员档位前缀
 * (与 protocol/reduce.ts 的 model_update 系统行同口径)。 */
function modelShortName(name: string): string {
  const noSuffix = name.replace(/@(?:baizhi|monkeycode)(?:#.*)?$/i, "") || name;
  return noSuffix.replace(/^monkeycode-[^/]+\//i, "") || noSuffix;
}

const THINK_LEVELS = ["off", "low", "medium", "high"] as const;
const THINK_KEY: Record<string, MessageKey> = {
  off: "chat.think.off",
  low: "chat.think.low",
  medium: "chat.think.medium",
  high: "chat.think.high",
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
  // dropdown 容器的关闭胶水:焦点移出即收起(官方 dropdown 的外点关闭语义);
  // Esc 就地拦截并阻断冒泡——不能让这一下落进全局审批链(esc = 不可逆拒绝)
  const onPickerBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPicker(null);
  };
  const onPickerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || picker === null) return;
    e.preventDefault();
    e.stopPropagation();
    setPicker(null);
  };
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

      {/* 聚焦时边界强调:focus-within 转品牌色描边。斜杠面板挂 daisyUI
          dropdown 外壳(受控 dropdown-open,焦点始终留在 textarea) */}
      <div
        className={`dropdown dropdown-top dropdown-start relative flex flex-col rounded-box border border-base-300 bg-base-100 transition-colors duration-150 focus-within:border-primary/60 ${slashOpen ? "dropdown-open" : ""}`}
      >
        {slashOpen && (
          <ul
            role="listbox"
            aria-label={t("chat.slash.label")}
            className="dropdown-content menu max-h-64 w-80 flex-nowrap overflow-x-hidden overflow-y-auto rounded-box bg-base-100 p-2 shadow-sm"
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
              <span key={u.id} className="badge badge-ghost h-auto gap-1.5 py-1.5 text-xs">
                <span className="loading loading-spinner loading-xs" aria-hidden />
                <span className="max-w-40 truncate">{u.name}</span>
                {u.pct >= 0 && <span className="tabular-nums opacity-60">{u.pct}%</span>}
                {u.cancel && (
                  <button type="button" aria-label={t("chat.uploadCancel")} className="cursor-pointer" onClick={u.cancel}>
                    <X size={12} strokeWidth={1.75} aria-hidden />
                  </button>
                )}
              </span>
            ))}
            {ctl.atts.map((a, i) => (
              <span key={a.path} title={a.path} className="badge badge-ghost h-auto gap-1.5 py-1.5 text-xs">
                <span className="max-w-40 truncate">{a.name}</span>
                <button type="button" aria-label={t("chat.attachRemove")} className="cursor-pointer" onClick={() => ctl.removeAtt(i)}>
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

        {/* min-w-0:长模型名可收缩截断,不得把发送按钮挤出卡片 */}
        <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
          <button
            type="button"
            title={t("chat.mode.tip")}
            className={`btn btn-xs rounded-full ${yolo ? "btn-warning" : "btn-ghost text-base-content/60"}`}
            onClick={toggleMode}
          >
            {yolo ? t("chat.mode.yolo") : t("chat.mode.default")}
          </button>
          <span className="min-w-0 flex-1" />

          <div
            className={`dropdown dropdown-top dropdown-end shrink-0 ${picker === "think" ? "dropdown-open" : ""}`}
            onBlur={onPickerBlur}
            onKeyDown={onPickerKeyDown}
          >
            <button
              type="button"
              disabled={state.running}
              title={state.running ? t("chat.switchWhileRunning") : t("chat.think.tip")}
              className="btn btn-ghost btn-xs font-normal text-base-content/60"
              onClick={() => setPicker(picker === "think" ? null : "think")}
            >
              {t("chat.think.trigger", { label: t(THINK_KEY[effThink] ?? "chat.think.low") })}
            </button>
            {picker === "think" && (
                <ul
                  aria-label={t("chat.think.label")}
                  className="dropdown-content menu w-52 rounded-box bg-base-100 p-2 shadow-sm"
                >
                  {THINK_LEVELS.map((level) => (
                    <li key={level}>
                      <button
                        type="button"
                        aria-current={level === effThink ? "true" : undefined}
                        className={level === effThink ? "menu-active" : ""}
                        onClick={() => pickThink(level)}
                      >
                        {t(THINK_KEY[level] ?? "chat.think.low")}
                      </button>
                    </li>
                  ))}
                </ul>
            )}
          </div>

          <div
            className={`dropdown dropdown-top dropdown-end min-w-0 shrink ${picker === "model" ? "dropdown-open" : ""}`}
            onBlur={onPickerBlur}
            onKeyDown={onPickerKeyDown}
          >
            <button
              type="button"
              disabled={state.running}
              title={state.running ? t("chat.switchWhileRunning") : t("chat.model.tip")}
              className="btn btn-ghost btn-xs block max-w-52 truncate font-normal text-base-content/60"
              onClick={() => setPicker(picker === "model" ? null : "model")}
            >
              {modelShortName(currentModel) || t("chat.model.label")}
            </button>
            {picker === "model" && (
                <ul
                  aria-label={t("chat.model.label")}
                  className="dropdown-content menu max-h-72 w-64 flex-nowrap overflow-x-hidden overflow-y-auto rounded-box bg-base-100 p-2 shadow-sm"
                >
                  {models.length === 0 && (
                    <li className="menu-disabled">
                      <span className="text-xs">{t("chat.model.empty")}</span>
                    </li>
                  )}
                  {models.map((m) => (
                    <li key={m.name} className={m.locked ? "menu-disabled" : ""}>
                      <button
                        type="button"
                        disabled={m.locked}
                        title={m.locked ? t("chat.model.locked") : m.name}
                        aria-current={m.name === currentModel ? "true" : undefined}
                        className={`flex items-center gap-2 ${m.name === currentModel ? "menu-active" : ""}`}
                        onClick={() => pickModel(m.name)}
                      >
                        <span className="min-w-0 flex-1 truncate text-xs">{modelShortName(m.name)}</span>
                        {m.default && (
                          <span className="shrink-0 text-[10px] opacity-50">{t("chat.model.default")}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
            )}
          </div>

          {/* 布局规范:上下文用量是输入侧元信息,归 composer 集群右端 */}
          <span className="ms-auto" aria-hidden />
          {state.usage && state.usage.size > 0 && (
            <span
              className="shrink-0 font-mono text-[11px] text-base-content/40 tabular-nums"
              title={t("chat.contextUsage")}
            >
              {Math.round((state.usage.used / state.usage.size) * 100)}%
            </span>
          )}
          <button
            type="button"
            aria-label={t("chat.attach")}
            title={t("chat.attachTip")}
            className="btn btn-ghost btn-square btn-xs shrink-0 text-base-content/60"
            onClick={attach}
          >
            <Paperclip size={15} strokeWidth={1.75} aria-hidden />
          </button>
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
