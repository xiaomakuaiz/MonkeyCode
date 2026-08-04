// 实时任务面板(plan 帧驱动):钉在 composer 上方,不进对话流。
// 收起 = 一行摘要(进度 + 当前项),展开 = 限高滚动的只读勾选清单;
// 整卡随 plan 全量重发更新(daisyUI collapse 强制开合态)。
import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { useI18n } from "@/lib/i18n";
import type { PlanEntry } from "@/lib/protocol/types";

export function TaskPanel({ entries }: { entries: PlanEntry[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const done = entries.filter((e) => e.status === "completed").length;
  const current =
    entries.find((e) => e.status === "in_progress") ?? entries.find((e) => e.status === "pending");

  return (
    <div
      className={`collapse rounded-box border border-base-300 bg-base-100 ${open ? "collapse-open" : "collapse-close"}`}
    >
      <button
        type="button"
        aria-expanded={open}
        className="collapse-title flex min-h-0 items-center gap-2 px-3 py-2 text-xs"
        onClick={() => setOpen(!open)}
      >
        <span className="shrink-0 font-semibold">
          {t("chat.plan.progress", { done, total: entries.length })}
        </span>
        {!open && current && (
          <span className="min-w-0 flex-1 truncate text-left text-base-content/60">
            · {current.status === "in_progress" ? t("chat.plan.doing") : t("chat.plan.next")}:
            {current.content}
          </span>
        )}
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          aria-hidden
          className={`ml-auto shrink-0 text-base-content/40 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      <div className="collapse-content px-3">
        <ul className="flex max-h-44 flex-col gap-1 overflow-x-hidden overflow-y-auto pb-1 text-xs">
          {entries.map((e, i) => (
            <li key={e.id ?? i} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="checkbox checkbox-xs mt-px shrink-0"
                checked={e.status === "completed"}
                readOnly
                aria-label={e.content}
              />
              <span
                className={
                  e.status === "completed"
                    ? "line-through opacity-50"
                    : e.status === "in_progress"
                      ? "font-medium text-primary"
                      : ""
                }
              >
                {e.content}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
