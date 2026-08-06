// 云端任务 composer:与本地 Composer 同一形态语言(composerKit 一套件)——
// 错误条 + 输入卡(卡内顶端运行条 / 附件 chips / 无边框 textarea / 底部集群)。
// 底部集群:左 = 附件入口(隐藏 file input,WebView 原生对话框),右 =
// 模型切换(OptionMenu 分组,经控制流 switch_model)+ 上下文用量环
// (h.chat.usage,云端 usage_update 帧与本地同构)+ 发送。
// 发送/上传/切换/错误通道全在 useCloudTask 的 handle 上,本组件纯视图。
import { Paperclip, SendHorizontal, X } from "lucide-react";
import { useEffect, useRef, type ClipboardEvent, type CSSProperties, type KeyboardEvent } from "react";

import { ComposerCard, ErrorBar, RunBar, useAutosizeTextarea } from "@/features/chat/composer/composerKit";
import { OptionMenu } from "@/features/chat/composer/pickers";
import { useI18n } from "@/lib/i18n";
import { groupedCloudModelLabel } from "@/lib/cloud/options";
import { fmtK } from "@/lib/util/fmt";
import { createImeGuard } from "@/lib/util/slash";
import type { CloudTaskHandle } from "./useCloudTask";

export function CloudComposer({
  h,
  pending,
  onSend,
}: {
  h: CloudTaskHandle;
  /** VM 启动中:输入框禁用(占位文案提示就绪后可发) */
  pending: boolean;
  /** 发送动作由视图包一层(发送前重新贴底),内容仍取 h.input */
  onSend: () => void;
}) {
  const { t } = useI18n();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const imeRef = useRef(createImeGuard());
  useAutosizeTextarea(taRef, h.input);

  // 模型清单预取(幂等;失败保持 null,悬停菜单区再触发即重试)
  const { loadModels } = h;
  useEffect(() => loadModels(), [loadModels]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      // IME 组合期(或 WKWebView 上组合刚结束 100ms 窗口内)的 Enter 是选字
      if (imeRef.current.isImeEnter(e.timeStamp, e.nativeEvent.isComposing)) return;
      e.preventDefault();
      onSend();
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
      h.addFiles(files);
    }
  };

  const onPickFiles = (list: FileList | null) => {
    if (list?.length) h.addFiles([...list]);
    // 复位 value:同一文件再次选择也要触发 change
    if (fileRef.current) fileRef.current.value = "";
  };

  // 运行条 detail:云端没有轮次概念,给累计 tokens(详情统计,轮询刷新)
  const tokens = h.meta?.stats?.total_tokens ?? 0;
  const runningDetail = tokens > 0 ? `${fmtK(tokens)} tokens` : undefined;

  // 模型菜单:当前项 = 详情里的模型;切换中触发器换文案
  const currentModelId = h.meta?.model?.id ?? "";
  const currentModelName = h.meta?.model?.remark || h.meta?.model?.model || t("cloud.model.label");
  const modelSections = (h.models ?? []).map((g) => ({
    key: g.key,
    label: g.label,
    ...(g.badge ? { badge: g.badge } : {}),
    options: g.models.map((m) => ({
      value: m.id ?? "",
      label: groupedCloudModelLabel(m),
      disabled: m.locked,
      // 锁定(超会员档)可见说明:行尾「未解锁」+ 悬停解锁路径(disabled
      // 按钮不弹 tooltip,hint 由 OptionMenu 挂在 li 上)
      ...(m.locked ? { note: t("settings.models.lockedBadge"), hint: t("chat.model.locked") } : {}),
    })),
  }));

  // 上下文用量(usage_update 帧,云端与本地同构;>85% 示警,同 Composer)
  const usage = h.chat.usage;
  const usagePct = usage && usage.size > 0 ? Math.round((usage.used / usage.size) * 100) : null;

  return (
    <div className="flex flex-col gap-2">
      {h.err && <ErrorBar text={h.err} onDismiss={h.clearErr} />}

      <ComposerCard>
        {h.running && (
          <RunBar
            label={t("cloud.view.running")}
            detail={runningDetail}
            stopLabel={t("chat.stop")}
            stopTitle={t("cloud.view.cancelRun")}
            onStop={h.cancelRun}
          />
        )}

        {(h.uploading > 0 || h.atts.length > 0) && (
          <div className="flex flex-wrap gap-2 px-3 pt-2">
            {h.atts.map((a, i) => (
              <span key={a.url} title={a.filename} className="badge badge-ghost text-xs">
                <span className="max-w-40 truncate">{a.filename}</span>
                <button
                  type="button"
                  aria-label={t("chat.attachRemove")}
                  className="btn btn-ghost btn-circle btn-xs"
                  onClick={() => h.removeAtt(i)}
                >
                  <X size={12} strokeWidth={1.75} aria-hidden />
                </button>
              </span>
            ))}
            {h.uploading > 0 && (
              <span className="badge badge-ghost text-xs">
                <span className="loading loading-spinner loading-xs" aria-hidden />
                {t("cloud.attach.uploading")}
              </span>
            )}
          </div>
        )}

        <textarea
          ref={taRef}
          aria-label={t("chat.composer")}
          className="textarea min-h-10 w-full resize-none border-0 bg-transparent text-sm shadow-none focus:outline-none"
          rows={2}
          placeholder={pending ? t("cloud.view.composerPending") : t("cloud.view.composerPlaceholder")}
          value={h.input}
          onChange={(e) => h.setInput(e.target.value)}
          onCompositionEnd={(e) => imeRef.current.markEnd(e.timeStamp)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={pending}
        />

        {/* 底部集群(同 Composer 口径:ps-1 光学对齐/pe-2 发送钮留白):
            左 = 附件入口,右 = 模型切换 + 用量环 + 发送 */}
        <div className="flex min-w-0 items-center gap-1 ps-1 pe-2 pb-1.5">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => onPickFiles(e.target.files)}
          />
          <button
            type="button"
            aria-label={t("chat.attach")}
            title={t("chat.attachTip")}
            className="btn btn-ghost btn-square btn-xs shrink-0 text-base-content/60"
            disabled={pending}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip size={15} strokeWidth={1.75} aria-hidden />
          </button>
          <span className="min-w-0 flex-1" />

          {/* 悬停即(重)拉模型清单:loadModels 幂等,失败后这里就是重试入口 */}
          <span className="contents" onPointerEnter={() => h.loadModels()}>
            <OptionMenu
              ariaLabel={t("cloud.model.label")}
              value={currentModelId}
              triggerLabel={h.switching ? t("cloud.model.switching") : currentModelName}
              onPick={(id) => void h.switchModel(id)}
              disabled={pending || h.running || h.switching}
              title={h.running ? t("chat.switchWhileRunning") : t("cloud.model.tip")}
              sections={modelSections}
              align="end"
            />
          </span>

          {usagePct !== null && usage && (
            <div
              className="tooltip tooltip-left mx-1 shrink-0"
              data-tip={t("chat.usageTip", { pct: usagePct, used: fmtK(usage.used), size: fmtK(usage.size) })}
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
            disabled={pending || !h.input.trim()}
            onClick={onSend}
          >
            <SendHorizontal size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </ComposerCard>
    </div>
  );
}
