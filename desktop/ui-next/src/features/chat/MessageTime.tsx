// 块级时间(用户气泡/助手正文/思考块/工具卡共用):HH:MM 悬停显影——
// 恒占位只切透明度(§6.2 铁律不插布局),依赖最近的 `group` 祖先;
// dateTime/title 保留完整时刻供无障碍与悬停查证。
export function MessageTime({ timestamp, className = "" }: { timestamp?: number; className?: string }) {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
      className={`text-[10px] text-base-content/40 opacity-0 transition-opacity select-none group-hover:opacity-100 ${className}`}
    >
      {hhmm}
    </time>
  );
}
