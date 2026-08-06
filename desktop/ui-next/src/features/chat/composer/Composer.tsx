// 全功能 composer:自适应高度输入(IME 守卫)+ 斜杠指令面板 + 附件
// (对话框/粘贴;拖拽由 ChatView 转入 ctl.addFiles)+ 运行条/排队 chip +
// 模型/思考档/权限模式控制。状态机在 useComposer,纯逻辑在 lib/util/slash。
// 发送面契约见 useComposer 文件头;切模型/思考/模式经 lib/ipc/controls
// (session_call),成功不乐观回写——壳会补 model_update / think_update /
// permission_mode_update 帧,ChatState 是唯一真值。
import { Clock3, Paperclip, SendHorizontal, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useI18n } from "@/lib/i18n";
import { sessionSetMode, sessionSetModel, sessionSetThink } from "@/lib/ipc/controls";
import { modelsList, type ModelInfo, type SessionMeta } from "@/lib/ipc/sessions";
import { pickAttachmentPaths } from "@/lib/ipc/uploads";
import type { ChatState, SlashCommand } from "@/lib/protocol/types";
import { fmtK } from "@/lib/util/fmt";
import { commandText, createImeGuard, cycleIndex, filterCommands, slashQuery } from "@/lib/util/slash";
import { ComposerCard, ErrorBar, RunBar, useAutosizeTextarea } from "./composerKit";
import { ModelMenu, ThinkMenu } from "./pickers";
import type { ComposerCtl } from "./useComposer";

// 模型/思考档下拉的形态与逻辑收口在 ./pickers(新建任务页共用同一组件);
// 模型展示投影(短名/档位)统一走 lib/models/modelMenu(protocol/reduce.ts
// 的 model_update 系统行是同一剥名口径,几处必须一致)。

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
  useAutosizeTextarea(taRef, ctl.draft);

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
    if (!name || name === currentModel) return;
    void sessionSetModel(sessionId, name).catch((e) => {
      ctl.notifyError(t("chat.model.failed", { reason: errText(e) }));
    });
  };
  const pickThink = (level: string) => {
    if (level === effThink) return;
    void sessionSetThink(sessionId, level).catch((e) => {
      ctl.notifyError(t("chat.think.failed", { reason: errText(e) }));
    });
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
  // 运行条 detail:「第 N 轮 · X tokens」(旧 UI RunningBar 同款;轮数 = user 项计数)
  const roundNo = Math.max(1, state.items.filter((it) => it.kind === "user").length);
  const runningDetail =
    t("chat.running.round", { round: roundNo }) +
    (state.usage && state.usage.used > 0 ? ` · ${fmtK(state.usage.used)} tokens` : "");
  const usagePct =
    state.usage && state.usage.size > 0 ? Math.round((state.usage.used / state.usage.size) * 100) : null;

  return (
    <div className="flex flex-col gap-2">
      {/* composer 域的两条瞬态反馈,统一形态(错误条件收口在 composerKit):
          soft 底 + 14px 语义图标 + truncate 正文 + 右端关闭 */}
      {ctl.error && <ErrorBar text={ctl.error} onDismiss={ctl.dismissError} />}

      {ctl.queued && (
        <div className="alert alert-soft -mx-2.5 flex items-center gap-2 px-3 py-1.5 text-xs">
          <Clock3 size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-base-content/50" />
          <span className="shrink-0 font-medium">{t("chat.queued")}</span>
          <span className="min-w-0 flex-1 truncate">{ctl.queued}</span>
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

      {/* 输入卡外框(形态收口在 composerKit:出血/聚焦边线/禁挂 dropdown 类
          的缘由见 ComposerCard 头注)。斜杠面板是卡内自绘浮层(绝对定位,
          焦点始终留在 textarea) */}
      <ComposerCard>
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
        {state.running && <RunBar label={runningLabel} detail={runningDetail} stopLabel={t("chat.stop")} onStop={ctl.stop} />}

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
            排布:左端 = 附件入口 + 模式 pill(用户定案 2026-08-06 对调,
            附件贴左缘),右端 = 思考/模型/用量/发送(输入侧元信息与动作)。
            ps-1 光学对齐:1px 边 + 4px + btn-xs 内距 8px = 13px,首个按钮
            的**内容**左缘与 textarea 文字(1px 边 + 12px 内距)重合——这排
            与输入文字/正文同一条竖线。pe-2:发送钮是实底色块没有幽灵内距,
            贴 4px 边显挤,右侧多留一档 */}
        <div className="flex min-w-0 items-center gap-1 ps-1 pe-2 pb-1.5">
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
            title={t("chat.mode.tip")}
            className={`btn btn-xs ${yolo ? "btn-warning btn-soft" : "btn-ghost font-medium text-base-content/70"}`}
            onClick={toggleMode}
          >
            {yolo ? t("chat.mode.yolo") : t("chat.mode.default")}
          </button>
          <span className="min-w-0 flex-1" />

          <ThinkMenu
            current={effThink}
            onPick={pickThink}
            disabled={state.running}
            title={state.running ? t("chat.switchWhileRunning") : t("chat.think.tip")}
          />
          <ModelMenu
            models={models}
            current={currentModel}
            onPick={pickModel}
            disabled={state.running}
            title={state.running ? t("chat.switchWhileRunning") : t("chat.model.tip")}
          />

          {/* 布局规范:上下文用量是输入侧元信息,归 composer 集群右端。
              形态:daisyUI radial-progress + tooltip(精确 tokens);>85% 用
              功能性状态色示警(旧 ContextRing 的设计,组件官方化) */}
          {usagePct !== null && state.usage && (
            <div
              // tooltip-left:圆环贴视口右缘,tooltip-top 居中弹会被窗口裁掉半截
              className="tooltip tooltip-left mx-1 shrink-0"
              // 紧凑口径:百分比 + fmtK 缩写(精确 token 数没有决策价值,
              // 长串数字把 tooltip 撑成一整行)
              data-tip={t("chat.usageTip", {
                pct: usagePct,
                used: fmtK(state.usage.used),
                size: fmtK(state.usage.size),
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
      </ComposerCard>
    </div>
  );
}
