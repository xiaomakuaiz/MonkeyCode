// 云端任务 composer:与本地 Composer 同一形态语言(composerKit 一套件)——
// 错误条 + 输入卡(卡内顶端运行条 / 无边框 textarea / 底部集群)。云端没有
// 附件/斜杠/模型热切,底部集群左端放静态元信息(模型名 · 分支),右端发送。
// 发送/中断/错误通道全在 useCloudTask 的 handle 上,本组件纯视图。
import { SendHorizontal } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

import { ComposerCard, ErrorBar, RunBar, useAutosizeTextarea } from "@/features/chat/composer/composerKit";
import { useI18n } from "@/lib/i18n";
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
  const imeRef = useRef(createImeGuard());
  useAutosizeTextarea(taRef, h.input);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      // IME 组合期(或 WKWebView 上组合刚结束 100ms 窗口内)的 Enter 是选字
      if (imeRef.current.isImeEnter(e.timeStamp, e.nativeEvent.isComposing)) return;
      e.preventDefault();
      onSend();
    }
  };

  // 运行条 detail:云端没有轮次概念,给累计 tokens(详情统计,轮询刷新)
  const tokens = h.meta?.stats?.total_tokens ?? 0;
  const runningDetail = tokens > 0 ? `${fmtK(tokens)} tokens` : undefined;

  // 底部集群左端静态词:模型名 · 分支(有啥显啥;都缺省时留空撑位)
  const modelName = h.meta?.model?.remark || h.meta?.model?.model || "";
  const branch = h.meta?.branch || "";

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
          disabled={pending}
        />

        {/* ps-1 + 文字 ps-2 光学对齐(同 Composer 底部集群口径):静态词左缘
            与 textarea 文字同一条竖线(1px 边 + 4px + 8px = 13px) */}
        <div className="flex min-w-0 items-center gap-1 ps-1 pe-2 pb-1.5">
          {modelName || branch ? (
            <span
              className="min-w-0 flex-1 truncate ps-2 text-[11px] text-base-content/50"
              title={[modelName, branch].filter(Boolean).join(" · ")}
            >
              {modelName}
              {modelName && branch && <span className="text-base-content/30"> · </span>}
              {branch && <span className="font-mono">{branch}</span>}
            </span>
          ) : (
            <span className="min-w-0 flex-1" />
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
