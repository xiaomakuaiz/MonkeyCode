// composer 共用呈现件(本地 Composer 与云端 CloudComposer 一套件,参照
// sidebar/listKit 先例;LAYOUT §6.2「不做两套」同一精神):错误条 / 运行条 /
// 输入卡外框 / textarea 自适应高度。类名是从 Composer 原样搬迁的定稿形态
// (-mx-2.5 出血、ps-1/pe-2 光学对齐等口径见 Composer 内注),改形态只改这里。
import { CircleAlert, CircleStop, X } from "lucide-react";
import { useEffect, type ReactNode, type RefObject } from "react";

import { useI18n } from "@/lib/i18n";

/** composer 域错误条:soft 底 + 14px 语义图标 + truncate 正文 + 右端关闭;
 * -mx-2.5 与输入卡同出血,左右缘对齐。 */
export function ErrorBar({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="alert alert-error alert-soft -mx-2.5 flex items-center gap-2 px-3 py-1.5 text-xs">
      <CircleAlert size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <button type="button" aria-label={t("chat.dismiss")} className="btn btn-ghost btn-square btn-xs" onClick={onDismiss}>
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

/** 运行条(输入卡内顶端,border-b 与卡体分隔):spinner + 文案 + 停止钮。 */
export function RunBar({
  label,
  detail,
  stopLabel,
  stopTitle,
  onStop,
}: {
  label: string;
  detail?: string;
  stopLabel: string;
  stopTitle?: string;
  onStop: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-base-300 px-3 py-1.5 text-xs">
      <span className="loading loading-spinner loading-xs text-primary" aria-hidden />
      <span className="font-semibold">{label}</span>
      {detail !== undefined && <span className="truncate text-base-content/40">{detail}</span>}
      <span className="flex-1" />
      <button
        type="button"
        aria-label={stopLabel}
        title={stopTitle ?? stopLabel}
        className="btn btn-ghost btn-square btn-xs text-error"
        onClick={onStop}
      >
        <CircleStop size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

/** 输入卡外框:结构线 + 默认底,聚焦时边线加深。**不得**给这层卡片挂
 * daisyUI dropdown 类:daisyUI 的隐藏规则是后代选择器
 * (`.dropdown:not(...) .dropdown-content`),外层 dropdown 处于关态时会把
 * 嵌套在内的菜单一并 display:none(思考菜单弹不出来的根因,修复经历见
 * tasks/lessons.md)。
 * -mx-2.5 光学对齐(旧 UI 出血 10px 随迁):textarea 自带 ~12px 内距,
 * 硬边卡片与正文同宽会显得输入文字向右缩;向两侧出血后卡内文字左缘与
 * 对话文字几乎重合,卡片略宽于正文列。 */
export function ComposerCard({ children }: { children: ReactNode }) {
  return (
    <div className="relative -mx-2.5 flex flex-col rounded-box border border-base-300 bg-base-100 shadow-sm transition-colors focus-within:border-base-content/25">
      {children}
    </div>
  );
}

const MAX_TEXTAREA_PX = 160;

/** 输入框随内容自适应高度(默认 ~160px 封顶,超出内滚)。 */
export function useAutosizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxPx = MAX_TEXTAREA_PX,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
  }, [ref, value, maxPx]);
}
