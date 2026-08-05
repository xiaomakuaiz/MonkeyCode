// 块级消息时间(块上方,用户/助手/思考/工具四类统一):HH:MM 悬停所在块
// (group 祖先)才显影——常驻是干扰信息(用户定案 2026-08-05 二次)。
// 恒占位只切透明度(§6.2 铁律不插布局);⚠️ 绝不挂 focus-within:点开
// 详情后焦点留在块内,时间/耗时会粘住不退(已踩过)。
// dateTime/title 保留完整时刻。
export function MessageTime({ timestamp, className = "" }: { timestamp?: number; className?: string }) {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
      className={`text-[10px] text-base-content/40 tabular-nums opacity-0 transition-opacity select-none group-hover:opacity-100 ${className}`}
    >
      {hhmm}
    </time>
  );
}
