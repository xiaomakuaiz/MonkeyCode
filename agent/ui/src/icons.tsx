// 设计稿的 SVG 图标集(路径数据逐一取自设计稿,线宽/圆角保持一致)。
// 统一约定:size 为正方形边长,color 为描边/填充色,默认取次级文字色。
import type { CSSProperties } from "react";

interface IconProps {
  size?: number;
  color?: string;
  style?: CSSProperties;
}

const base: CSSProperties = { flex: "none", display: "block" };

/** 文件夹 */
export function IconFolder({ size = 13, color = "var(--t3)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" style={{ ...base, ...style }}>
      <path
        d="M1.5 4a1.5 1.5 0 0 1 1.5-1.5h2.6l1.3 1.5H11A1.5 1.5 0 0 1 12.5 5.5v5A1.5 1.5 0 0 1 11 12H3a1.5 1.5 0 0 1-1.5-1.5V4z"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 云(云端任务) */
export function IconCloud({ size = 14, color = "var(--t5)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ ...base, ...style }}>
      <path
        d="M4.5 12.5a3 3 0 0 1-.4-5.97 4 4 0 0 1 7.8-.03 2.75 2.75 0 0 1-.4 6H4.5z"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 显示器(本地会话) */
export function IconMonitor({ size = 14, color = "var(--t5)", strokeWidth = 1.2, style }: IconProps & { strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ ...base, ...style }}>
      <rect x="2" y="3.5" width="12" height="7.5" rx="1.4" stroke={color} strokeWidth={strokeWidth} />
      <path d="M5.5 13.5h5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

/** 加号 */
export function IconPlus({ size = 11, color = "var(--t4)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" style={{ ...base, ...style }}>
      <path d="M6 2v8M2 6h8" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 右向 chevron(经 style transform rotate 表达展开态) */
export function IconChevronRight({ size = 10, color = "var(--t5)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" style={{ ...base, ...style }}>
      <path d="M3.5 2L7 5 3.5 8" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 下向 chevron(下拉指示) */
export function IconChevronDown({ size = 8, color = "var(--t6)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" style={{ ...base, ...style }}>
      <path d="M2 3.5 5 6.5 8 3.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** ⋯ 三点 */
export function IconDots({ size = 12, color = "var(--t3)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" style={{ ...base, ...style }}>
      <circle cx="3" cy="7" r="1.1" fill={color} />
      <circle cx="7" cy="7" r="1.1" fill={color} />
      <circle cx="11" cy="7" r="1.1" fill={color} />
    </svg>
  );
}

/** 归档盒 */
export function IconArchive({ size = 12, color = "var(--t3)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" style={{ ...base, ...style }}>
      <rect x="2" y="2.5" width="10" height="3" rx="1" stroke={color} strokeWidth="1.2" />
      <path d="M3 5.5v4A1.5 1.5 0 0 0 4.5 11h5A1.5 1.5 0 0 0 11 9.5v-4M5.5 7.5h3" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** 垃圾桶 */
export function IconTrash({ size = 12, color = "var(--err)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" style={{ ...base, ...style }}>
      <path
        d="M2.5 3.5h9M5.5 3.5v-1h3v1M4 3.5l.5 7A1.5 1.5 0 0 0 6 12h2a1.5 1.5 0 0 0 1.5-1.5l.5-7"
        stroke={color}
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 设置齿轮 */
export function IconGear({ size = 15, color = "var(--t3)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ ...base, ...style }}>
      <path
        d="M6.8 1.8h2.4l.3 1.6c.5.2 1 .4 1.4.8l1.6-.6 1.2 2-1.3 1.1c.05.25.1.55.1.85s-.05.6-.1.85l1.3 1.1-1.2 2-1.6-.6c-.4.35-.9.6-1.4.8l-.3 1.6H6.8l-.3-1.6c-.5-.2-1-.45-1.4-.8l-1.6.6-1.2-2 1.3-1.1A4.6 4.6 0 0 1 3.5 8c0-.3.03-.6.1-.85L2.3 6l1.2-2 1.6.6c.4-.35.9-.6 1.4-.8l.3-2z"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.9" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}

/** 分支(改动) */
export function IconBranch({ size = 12, color = "var(--t3)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" style={{ ...base, ...style }}>
      <path d="M4 2.5v6.2a2 2 0 1 0 1.3.05V4.8" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="4.6" cy="10.7" r="1.6" stroke={color} strokeWidth="1.2" />
      <circle cx="9.4" cy="3.3" r="1.6" stroke={color} strokeWidth="1.2" />
      <path d="M9.4 4.9v2.3a2 2 0 0 1-2 2h-.7" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** 时钟(排队) */
export function IconClock({ size = 13, color = "var(--t5)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" style={{ ...base, ...style }}>
      <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.2" />
      <path d="M7 4v3.2l2.2 1.3" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 关闭 × */
export function IconX({ size = 9, color = "var(--t5)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" style={{ ...base, ...style }}>
      <path d="M2 2l6 6M8 2L2 8" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 发送(上箭头) */
export function IconSend({ size = 13, color = "#fff", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" style={{ ...base, ...style }}>
      <path d="M7 11.5V2.8M3.2 6.3 7 2.5l3.8 3.8" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 盾牌(权限模式) */
export function IconShield({ size = 11, color = "var(--t3)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" style={{ ...base, ...style }}>
      <path d="M6 1.2 10 2.8v3c0 2.4-1.7 4.2-4 5-2.3-.8-4-2.6-4-5v-3L6 1.2z" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** 对勾 */
export function IconCheck({ size = 10, color = "var(--ok)", strokeWidth = 1.5, style }: IconProps & { strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" style={{ ...base, ...style }}>
      <path d="M1.5 5.5 4 8l4.5-6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 思考火花 */
export function IconSpark({ size = 12, color = "var(--acc)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" style={{ ...base, ...style }}>
      <path d="M6 1c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4z" fill={color} />
    </svg>
  );
}

/** 停止(实心圆角方块) */
export function IconStop({ size = 8, color = "var(--err)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" style={{ ...base, ...style }}>
      <rect width="8" height="8" rx="1.5" fill={color} />
    </svg>
  );
}

/** 感叹号圆圈(提示) */
export function IconInfo({ size = 13, color = "var(--warn)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" style={{ ...base, ...style }}>
      <circle cx="7" cy="7" r="5.8" stroke={color} strokeWidth="1.2" />
      <path d="M7 4.2v3.3M7 9.6v.4" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** 返回(左向 chevron) */
export function IconBack({ size = 10, color = "var(--t1)", style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" style={{ ...base, ...style }}>
      <path d="M6.5 2 3 5l3.5 3" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
