// 侧栏列表共用件:本地/对话/云端三列表同一套呈现与交互(用户定案
// 2026-08-05「统一风格和交互,不要做两套」;后续三空间会并入同一 tab 的
// 横向双 tab,先在组件层归一)。形态语汇 = LAYOUT.md §6.1/§6.2:
// - ListRow 安静行:单行主文案顶行首截断 + 行尾要紧态状态点(点替代
//   文字词,词进 title/aria);右键 = 行菜单。行首身份图标槽已撤(用户
//   定案 2026-08-06:侧栏行宽本就紧,图标占掉 20px 不值——身份由空间
//   tab 表达,行内不再重复)。
// - 组头/小节头图标保留(Folder/History/Archive):组级标签要锚点,
//   且一组只出一次不吃行宽。
// - GroupLabel 组头锚点:13px 图标 + 与行同字号的 font-semibold 满色名称
//   (2026-08-07 对表旧 UI 后推翻 08-04「小一档 + /50 的区块标签」——
//   详见该函数头注),放进 summary(flex 覆写、after:hidden 去尾箭头)。
// - SectionFold 小节折叠:Archive 形小节头(10px 图标行首、无计数),
//   开合走 prefs 契约键持久化,收起即卸载(部分 webview 里 details 收起
//   后嵌套 ul 残留占位空间)。
import { Archive, type LucideIcon } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";

import { openMenu, type MenuItem } from "@/lib/contextMenu";
import { readFold, writeFold, type FoldKey } from "@/lib/util/prefs";

// 缩进引导竖线(挂展开后的嵌套 ul):把子行归拢到组头名下。
// 为什么是竖线而不是空白(2026-08-07 用户三轮报障后的收敛):主流树组件
// ——VS Code 资源管理器、Finder 列表视图、JetBrains 项目树、GitHub 文件树、
// Notion 侧栏——**一律等距行 + 零组间空白**,层级只由「缩进 + 折叠箭头 +
// 引导竖线」表达。空白分组是 Slack/Linear 那种「少数几个固定分区」的手法,
// 项目数一多就把列表撑散(用户报障「项目之间太空了」正是此因)。
// start 值 = 该层组头图标的中心横坐标,竖线正落在图标列上(VS Code 同款:
// 线在 twisty 列,文字在其右)。绝对定位,不参与布局,行底照旧满宽。
const GUIDE = "relative before:absolute before:inset-y-0.5 before:w-px before:bg-base-content/15 before:content-['']";
/** L1:组头基准内距 12px + 12px 图标的一半 = 18px(项目组 / 云端项目组 / 底部小节) */
export const GUIDE_L1 = `${GUIDE} before:start-[18px]`;
/** L2:组内小节头 ps-6(24px)+ 10px 图标的一半 = 29px(项目内「已归档任务」) */
export const GUIDE_L2 = `${GUIDE} before:start-[29px]`;

/** 列表行(menu 的 li>a 载体):indent = 行内起始 padding 类(缩进阶梯
 * 进行内、行底满宽——嵌套 margin 会把 hover/选中底压窄错位)。 */
export function ListRow({
  primary,
  trailing,
  tooltip,
  indent,
  active,
  archived,
  attention,
  onSelect,
  menuItems,
}: {
  primary: string;
  /** 行尾状态点:仅要紧态给(tone = status-* 色 + 动效);状态词不上行
   * (用户定案 2026-08-05「文字换状态图标」),进点的 title/aria-label */
  trailing?: { tone: string; label: string } | null;
  tooltip: string;
  indent?: string;
  active?: boolean;
  /** 已归档:主文案降到 /55(旧 UI `--t4` 同档)——归档区的行还用正文色,
   *  在列表里和活跃任务一样抢眼(2026-08-07 用户报障「已归档的任务标题
   *  怎么还是黑色的」)。选中态不降,选中就该看清 */
  archived?: boolean;
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
        {/* 正文比组头浅一档(旧 UI `--t2` 92%):项目名才是锚点,任务挂在它
            下面;选中态交回 menu-active-fg,归档降到 /55 */}
        <span className={`min-w-0 flex-1 truncate ${active ? "" : archived ? "text-base-content/55" : "text-base-content/90"}`}>
          {primary}
        </span>
        {trailing && (
          <span role="img" aria-label={trailing.label} title={trailing.label} className={`status shrink-0 ${trailing.tone}`} />
        )}
      </a>
    </li>
  );
}

/** 组头标签:图标裸放 flex 行(图标不需要定宽槽,多包一层反而竖向对不齐),
 * 名称保留原大小写。
 *
 * **项目名是锚点,不是淡标签**(2026-08-07 用户报障「任务和项目的亲密性
 * 不够」后对表旧 UI sidebar.tsx 定案,推翻 08-04「区块标签 = 小一档 + /50」):
 * 旧 UI 里组头 12.5px/600/`--t1`(全列最深),任务行 12.5px/400/`--t2`(92%)
 * ——**组头比行更重**,任务才「挂」在项目下面。ui-next 此前做反了(组头
 * 12px//50 最淡、行 14px/100% 最深),项目名成了飘在一堆大黑字上方的说明
 * 文字,间距怎么调都不亲。现按旧 UI:同字号、加粗、满色;归档项目降一档。 */
export function GroupLabel({ icon: Icon, name, muted }: { icon: LucideIcon; name: string; muted?: boolean }) {
  return (
    <>
      <Icon
        size={13}
        strokeWidth={1.75}
        className={`shrink-0 ${muted ? "text-base-content/45" : "text-base-content/65"}`}
        aria-hidden
      />
      <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${muted ? "text-base-content/60" : ""}`}>{name}</span>
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
        {isOpen && <ul className={`ms-0 min-w-0 ps-0 pb-1.5 ${GUIDE_L1}`}>{children}</ul>}
      </details>
    </li>
  );
}
