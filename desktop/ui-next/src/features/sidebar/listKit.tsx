// 侧栏列表共用件:本地/对话/云端三列表同一套呈现与交互(用户定案
// 2026-08-05「统一风格和交互,不要做两套」;后续三空间会并入同一 tab 的
// 横向双 tab,先在组件层归一)。形态语汇 = LAYOUT.md §6.1/§6.2:
// - ListRow 安静行:行首 12px 身份图标槽(不被状态顶掉,用户定案
//   2026-08-05)+ 单行主文案截断 + 行尾要紧态状态点(点替代文字词,
//   词进 title/aria);右键 = 行菜单。
// - GroupLabel 区块标签:组头 12px 图标 + text-xs font-medium /50(比行
//   小一档;行 14px 后从 11px 提到 12px,免得差距拉到 3px 显得过小),
//   放进 summary(flex 覆写、after:hidden 去尾箭头)。
// - SectionFold 小节折叠:Archive 形小节头(10px 图标行首、无计数),
//   开合走 prefs 契约键持久化,收起即卸载(部分 webview 里 details 收起
//   后嵌套 ul 残留占位空间)。
import { Archive, type LucideIcon } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";

import { openMenu, type MenuItem } from "@/lib/contextMenu";
import { readFold, writeFold, type FoldKey } from "@/lib/util/prefs";

/** 行首定宽 12px 身份图标槽,与组头图标同列(裸文字顶行首太秃,用户
 * 定案 2026-08-05);状态一律走行尾状态点,不顶掉身份图标(用户定案
 * 2026-08-05)。 */
export function IconSlot({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span aria-hidden className="flex w-3 shrink-0 justify-center">
      <Icon size={12} strokeWidth={1.75} className="text-base-content/40" />
    </span>
  );
}

/** 列表行(menu 的 li>a 载体):indent = 行内起始 padding 类(缩进阶梯
 * 进行内、行底满宽——嵌套 margin 会把 hover/选中底压窄错位)。 */
export function ListRow({
  primary,
  slot,
  trailing,
  tooltip,
  indent,
  active,
  attention,
  onSelect,
  menuItems,
}: {
  primary: string;
  slot: ReactNode;
  /** 行尾状态点:仅要紧态给(tone = status-* 色 + 动效);状态词不上行
   * (用户定案 2026-08-05「文字换状态图标」),进点的 title/aria-label */
  trailing?: { tone: string; label: string } | null;
  tooltip: string;
  indent?: string;
  active?: boolean;
  /** 后台提醒未读(D3):行淡警示底(功能性状态色,§8 白名单) */
  attention?: boolean;
  onSelect: () => void;
  menuItems: MenuItem[];
}) {
  return (
    <li>
      <a
        className={`flex min-w-0 items-center gap-2 overflow-hidden transition-colors duration-150 ${indent ?? ""} ${active ? "menu-active" : ""}${attention ? " bg-warning/10" : ""}`}
        data-attention={attention ? "" : undefined}
        title={tooltip}
        onClick={onSelect}
        onContextMenu={(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu({ x: e.clientX, y: e.clientY }, menuItems);
        }}
      >
        {slot}
        <span className="min-w-0 flex-1 truncate">{primary}</span>
        {trailing && (
          <span role="img" aria-label={trailing.label} title={trailing.label} className={`status shrink-0 ${trailing.tone}`} />
        )}
      </a>
    </li>
  );
}

/** 区块标签(组头 summary 内容):图标裸放 flex 行(12px 图标不需要定宽
 * 槽,多包一层反而竖向对不齐),名称保留原大小写。 */
export function GroupLabel({ icon: Icon, name }: { icon: LucideIcon; name: string }) {
  return (
    <>
      <Icon size={12} strokeWidth={1.75} className="shrink-0 text-base-content/40" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-base-content/50">{name}</span>
    </>
  );
}

/** 底部小节折叠(已归档项目/已归档会话/云端历史任务):开合态走旧 UI
 * 契约键;标签不带计数(用户定案 2026-08-05)。 */
export function SectionFold({
  label,
  icon: Icon = Archive,
  foldKey,
  forceOpen = false,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  foldKey: FoldKey;
  /** 搜索命中等场景强制展开:不写盘、不响应开合 */
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => readFold(foldKey));
  const isOpen = forceOpen || open;
  return (
    <li>
      <details
        open={isOpen}
        onToggle={(e) => {
          if (e.target !== e.currentTarget) return; // toggle 合成冒泡守卫
          if (forceOpen) return;
          const next = e.currentTarget.open;
          if (next === open) return;
          setOpen(next);
          writeFold(foldKey, next);
        }}
      >
        {/* Archive 形小节头:图标行首(与组头 Folder 同构)、去 menu 默认尾箭头 */}
        <summary className="flex items-center gap-2 text-xs text-base-content/50 after:hidden">
          <Icon size={10} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </summary>
        {/* 收起即卸载:防 details 收起后嵌套 ul 残留占位空间 */}
        {isOpen && <ul className="ms-0 min-w-0 ps-0 before:hidden">{children}</ul>}
      </details>
    </li>
  );
}
