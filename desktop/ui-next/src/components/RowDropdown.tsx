// 列表行的「…」下拉菜单(侧栏会话行 / 云端任务行共用):与右键菜单
// (lib/contextMenu.openMenu)共享同一份 MenuItem,confirm 项在下拉里走
// 本地二段确认态(第一次点换文案不关菜单,失焦复位)。按钮的显隐由行侧
// 的 group 类驱动:hover/焦点进入行时原位换出(与行右侧 meta 文字互斥)。
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";

import type { MenuItem } from "@/lib/contextMenu";

export function RowDropdown({ label, items }: { label: string; items: MenuItem[] }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <div className="dropdown dropdown-end" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        tabIndex={0}
        aria-label={label}
        className="btn btn-ghost btn-square btn-xs hidden group-hover:inline-flex group-focus-within:inline-flex"
        onBlur={() => setConfirming(null)}
      >
        <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <ul className="dropdown-content menu menu-sm z-10 w-40 rounded-box bg-base-100 p-2 shadow-sm">
        {items.map((it) => (
          <li key={it.label}>
            <button
              type="button"
              className={it.danger ? "text-error" : undefined}
              onClick={(e) => {
                if (it.confirm && confirming !== it.label) {
                  e.preventDefault();
                  setConfirming(it.label);
                  return;
                }
                setConfirming(null);
                it.run();
              }}
            >
              {it.confirm && confirming === it.label ? it.confirm : it.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
