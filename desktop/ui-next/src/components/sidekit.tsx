// 侧栏视觉件(本地/云端列表共用)。设计基线 = 旧 UI(desktop/ui sidebar.tsx)
// 的桌面密度语言:34px 组头行、13px 文件夹图标/9px 旋转箭头、10.5px 区标签、
// 卡片式空态。色彩全部走 daisyUI 语义变量(base-content 灰阶 / primary)。
import { ChevronRight, Folder } from "lucide-react";
import type { DragEvent, MouseEvent, ReactNode } from "react";

/** 区标签(快速任务/项目):10.5px 加粗微距。 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="px-[9px] pb-1 pt-[3px] text-[10.5px] font-bold tracking-[0.35px] text-base-content/45">{children}</span>;
}

/** 可折叠组头:项目 = 文件夹图标 + 12.5px 半粗;小节 = 旋转箭头 + 11.5px。
 *  hover 在右侧浮现快捷「+」;拖拽落点画 2px 主色指示线。 */
export function GroupHeader({
  name,
  project = false,
  muted = false,
  archived = false,
  depth = 0,
  expanded,
  onToggle,
  title,
  quickAdd,
  onContextMenu,
  drag,
  dropTarget = false,
}: {
  name: string;
  project?: boolean;
  muted?: boolean;
  archived?: boolean;
  depth?: number;
  expanded: boolean;
  onToggle: () => void;
  title?: string;
  quickAdd?: { label: string; onClick: () => void };
  onContextMenu?: (e: MouseEvent) => void;
  drag?: {
    onDragStart: () => void;
    onDragOver: (e: DragEvent) => void;
    onDragEnd: () => void;
    onDrop: (e: DragEvent) => void;
  };
  dropTarget?: boolean;
}) {
  const tone = muted ? "text-base-content/45" : archived ? "text-base-content/70" : "text-base-content";
  const iconTone = muted || archived ? "text-base-content/45" : "text-base-content/70";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      title={title}
      className={`group relative flex min-h-[34px] cursor-pointer select-none items-center gap-1.5 rounded-lg pe-[5px] hover:bg-base-content/5 ${
        project ? "text-[12.5px] font-semibold" : "text-[11.5px] font-medium"
      } ${tone}`}
      style={{ paddingInlineStart: 7 + Math.max(0, depth) * 14 }}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      onContextMenu={onContextMenu}
      draggable={!!drag}
      onDragStart={drag ? () => drag.onDragStart() : undefined}
      onDragOver={drag?.onDragOver}
      onDragEnd={drag ? () => drag.onDragEnd() : undefined}
      onDrop={drag?.onDrop}
    >
      {dropTarget && <span aria-hidden className="absolute inset-x-1.5 -top-0.5 h-0.5 rounded-[1px] bg-primary" />}
      <span className="flex h-[13px] w-[13px] flex-none items-center justify-center">
        {project ? (
          <Folder size={13} strokeWidth={1.75} className={iconTone} aria-hidden />
        ) : (
          <ChevronRight
            size={9}
            strokeWidth={2.5}
            className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
            aria-hidden
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {quickAdd && (
        <button
          type="button"
          aria-label={quickAdd.label}
          title={quickAdd.label}
          className="absolute right-1 top-1.5 hidden h-[22px] w-[22px] flex-none items-center justify-center rounded-md text-base-content/70 group-hover:flex group-focus-within:flex hover:bg-base-content/10"
          onClick={(e) => {
            e.stopPropagation();
            quickAdd.onClick();
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** 空态:卡片图标 + 标题档 + 辅助档,居中。 */
export function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="mx-1 my-5 flex flex-col items-center gap-2 px-3.5 py-[18px] text-center">
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[11px] border border-base-content/10 bg-base-100 text-base-content/35 shadow-sm">
        {icon}
      </span>
      <span className="text-[12.5px] font-semibold text-base-content/70">{title}</span>
      <span className="max-w-[175px] text-[11px] leading-[1.6] text-base-content/45">{detail}</span>
    </div>
  );
}
