// 提问大纲:正文左缘一列小点(每个 UserItem 一点),悬停浮出条目面板,
// 点条目滚到对应气泡。数据 = 壳的 session_outline 全量目录(含未加载进
// 对话流的更早提问)+ 流内实时用户消息合并(刚发的提问不等轮末物化)。
// 点本身不响应点击:目标太小,误点代价是整屏跳走;跳转由 ChatView 执行
// (锚不在 DOM 时先 loadEarlier 循环补页)。
import { useState } from "react";

import { useI18n } from "@/lib/i18n";
import type { OutlineItem } from "@/lib/ipc/controls";
import type { ChatItem } from "@/lib/protocol/types";

/** 本地附件行(与 composer attLine / 旧 UI ATT_LINE 同口径):大纲摘要剥掉。 */
export const ATT_LINE = /^\[(图片|文件)\] \S+$/;

const MAX_LABEL = 60;

export interface OutlineEntry {
  /** 与 UserItem.seq / DOM 的 data-user-seq 对表。 */
  seq: number;
  /** 摘要正文(空 = 纯附件/空消息,渲染层给兜底文案)。 */
  label: string;
  /** 剥离的附件行数(label 为空时兜底展示「N 个附件」)。 */
  attCount: number;
  /** HH:MM;无可靠时间为空。 */
  time: string;
}

function hhmm(ts?: number): string {
  if (ts === undefined || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 目录 + 流内实时用户消息 → 合并去重的大纲条目。
 * 目录是磁盘数据,刚发的提问要等轮末物化;凡带 seq 的流内用户条目且目录
 * 没有的补到尾部(必然是最新几条,天然有序)。撞 seq 只留首条:seq 是
 * 跳转锚,两条同 seq 只能定位到同一气泡。 */
export function outlineEntriesOf(outline: OutlineItem[], items: readonly ChatItem[]): OutlineEntry[] {
  const merged: Array<{ seq: number; text: string; timestamp?: number }> = [...outline];
  const seen = new Set(outline.map((o) => o.seq));
  for (const it of items) {
    if (it.kind !== "user" || it.seq === undefined || seen.has(it.seq)) continue;
    seen.add(it.seq);
    merged.push({ seq: it.seq, text: it.text, ...(it.timestamp !== undefined ? { timestamp: it.timestamp } : {}) });
  }
  const out: OutlineEntry[] = [];
  const emitted = new Set<number>();
  for (const it of merged) {
    if (emitted.has(it.seq)) continue;
    emitted.add(it.seq);
    const body: string[] = [];
    let attCount = 0;
    for (const line of it.text.split("\n")) {
      if (ATT_LINE.test(line)) attCount += 1;
      else body.push(line);
    }
    const text = body.join(" ").replace(/\s+/g, " ").trim();
    const label = text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL)}…` : text;
    out.push({ seq: it.seq, label, attCount, time: hhmm(it.timestamp) });
  }
  return out;
}

/** 点列常驻 + 悬停浮出面板(daisyUI dropdown 外壳,受控 dropdown-open)。
 * dropdown-right 让面板紧贴点列右缘、无空隙,指针点列↔面板不离开容器,
 * 容器级 mouseenter/leave 即可管开合(mouseleave 把绝对定位子面板算在内),
 * 旧 200ms 延时收起随空隙一起退役。 */
export function OutlineNav({
  entries,
  onJump,
}: {
  entries: OutlineEntry[];
  onJump: (seq: number) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  // 一条提问的会话不值得占一条轨道
  if (entries.length < 2) return null;

  const labelOf = (e: OutlineEntry) =>
    e.label ||
    (e.attCount > 0 ? t("chat.outline.attachments", { count: e.attCount }) : t("chat.outline.emptyMsg"));

  return (
    <nav
      aria-label={t("chat.outline.label")}
      className="pointer-events-none absolute inset-y-0 left-1 z-10 flex w-5 items-center"
    >
      <div
        className={`dropdown dropdown-right dropdown-center pointer-events-auto max-h-[60%] ${open ? "dropdown-open" : ""}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="flex max-h-full flex-col items-center gap-1.5 overflow-hidden px-1.5 py-2">
          {entries.map((e) => (
            <span key={e.seq} aria-hidden className="status shrink-0" />
          ))}
        </div>
        {open && (
          <ul className="dropdown-content menu max-h-[70vh] w-64 flex-nowrap overflow-x-hidden overflow-y-auto rounded-box bg-base-100 p-2 shadow-sm">
            {entries.map((e) => (
              <li key={e.seq}>
                <button
                  type="button"
                  className="flex items-baseline gap-2"
                  onClick={() => {
                    setOpen(false);
                    onJump(e.seq);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-left text-xs">{labelOf(e)}</span>
                  {e.time && <span className="shrink-0 text-[10px] opacity-50">{e.time}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
