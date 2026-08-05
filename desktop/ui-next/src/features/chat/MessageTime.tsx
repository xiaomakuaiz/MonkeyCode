// 块级时间(用户气泡/助手正文/思考块/工具卡共用):HH:MM 常驻弱化显示。
// 曾是 hover 显影(§6.2 铁律形态),但 WebKitGTK 的 :hover 在 DOM 变动后
// 粘滞/失灵(耗时不退、details 上不触发),且用户诉求本就是「时间要看
// 得到」——2026-08-05 定案改常驻;dateTime/title 保留完整时刻。
export function MessageTime({ timestamp, className = "" }: { timestamp?: number; className?: string }) {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
      className={`text-[10px] text-base-content/40 tabular-nums select-none ${className}`}
    >
      {hhmm}
    </time>
  );
}
