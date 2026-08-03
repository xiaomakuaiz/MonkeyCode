// 云端任务详情视图(纯视图层):回放/跟看/操作 monkeycode 云端任务。
// 连接编排在 useCloudTask,协议状态机在 lib/cloud/stream;渲染复用本地
// 会话的帧归约链(reduceBatch → LogList,云端帧与本地 Frame 同构)。
// - pending:整屏启动时间线(StartupTimeline),此时必然还没有对话;
// - processing:attach 跟看 + 简版输入 + 停止/中断;
// - finished/error:REST rounds 只读回放,「加载更早」按 cursor 往前翻。
// 提问大纲:数据 = REST 提问索引(全量目录)+ 已回放窗口的用户消息按时间锚
// 合并(lib/cloud/outline),渲染复用本地 OutlineNav;跳转目标未加载时经
// loadEarlier 大步长补页——effect 驱动(每页提交后重查),上限防死循环。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { LogList } from "@/features/chat/LogList";
import { OutlineNav, outlineEntriesOf } from "@/features/chat/OutlineNav";
import { useI18n, type MessageKey } from "@/lib/i18n";
import type { CloudTask } from "@/lib/ipc/cloudtasks";
import type { OutlineItem } from "@/lib/ipc/controls";
import { cloudAnchorIndex, fetchCloudOutline, withCloudAnchors } from "@/lib/cloud/outline";
import type { StreamStatus } from "@/lib/cloud/stream";
import { CloudFiles } from "./CloudFiles";
import { CloudTerminal } from "./CloudTerminal";
import { StartupTimeline } from "./StartupTimeline";
import { useCloudTask } from "./useCloudTask";

const PIN_THRESHOLD = 40; // 距底多少像素内算"贴底"
const JUMP_MAX_PAGES = 80; // 大纲跳转补页上限(坏锚/游标不前进时不空转)
const JUMP_STEP = 10; // 补页步长(轮/页;壳侧 mc_task_rounds 的 limit 上限)
const FLASH_MS = 1100; // 与 chrome.css mc-flash 动画时长对齐(略长于 1s)

const STATUS_BADGE: Record<string, string> = {
  pending: "badge-warning",
  processing: "badge-primary",
  error: "badge-error",
  finished: "badge-ghost",
};

/** 连接状态 → 外显文案;健康态(已连接/本轮结束)返回 null 不渲染——
 * 常驻"已连接云端"是噪音,异常/过渡态才值得占一行。 */
function statusText(t: ReturnType<typeof useI18n>["t"], status: StreamStatus | null): string | null {
  switch (status?.kind) {
    case "connecting":
      return t("cloud.conn.connecting");
    case "reconnecting":
      return t("cloud.conn.reconnecting", { seconds: Math.round(status.delayMs / 1000) }) + (status.reason ? `(${status.reason})` : "");
    case "sendFailed":
      return t("cloud.conn.sendFailed");
    case "dialGaveUp":
      return t("cloud.conn.dialGaveUp") + (status.reason ? `(${status.reason})` : "");
    case "dropGaveUp":
      return t("cloud.conn.dropGaveUp");
    default:
      return null;
  }
}

export function CloudTaskView({
  task,
  onTasksChanged,
}: {
  /** 侧栏/新建入口带进来的任务(至少含 id;详情异步补全)。
   * 契约:App 以 task.id 为 key 挂载本视图(id 在一次挂载内不变)。 */
  task: CloudTask;
  /** 状态变化(停止/结束)后让 App 刷新侧栏列表 */
  onTasksChanged?: () => void;
}) {
  const { t } = useI18n();
  const h = useCloudTask(task, { onTasksChanged });
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // ==== 提问大纲:REST 全量目录(挂载拉一次;运行中新增的提问靠实时合并) ====
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  useEffect(() => {
    setOutline([]);
    let alive = true;
    fetchCloudOutline(h.id)
      .then((items) => {
        if (alive) setOutline(items);
      })
      .catch((e: unknown) => {
        // 大纲缺席可接受(降级为只有流内条目),但失败必须留痕:命令没进
        // ACL 白名单这类故障,静默吞掉就只剩"点了没反应"
        console.warn("[cloud-outline] 提问索引拉取失败:", e);
      });
    return () => {
      alive = false;
    };
  }, [h.id]);
  const entries = useMemo(() => outlineEntriesOf(outline, withCloudAnchors(h.chat.items)), [outline, h.chat.items]);

  // ==== 大纲跳转:effect 驱动的补页循环(锚 = 10ms 时间锚,见 lib/cloud/outline) ====
  const [jumpAnchor, setJumpAnchor] = useState<number | null>(null);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  const jumpTries = useRef(0);
  const flashTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  useEffect(() => {
    if (jumpAnchor === null) return;
    const idx = cloudAnchorIndex(h.chat.items, jumpAnchor);
    if (idx >= 0) {
      setJumpAnchor(null);
      // LogList 结构契约:根节点直接子元素与 items 一一对应
      const node = listRef.current?.firstElementChild?.children.item(idx);
      (node as HTMLElement | null)?.scrollIntoView?.({ block: "start" });
      // 闪光走 LogList 的 flashSeq(按帧原生 seq 对表);云端旧帧可缺 seq,
      // 那就只滚动不闪,定位本身不受影响
      const it = h.chat.items[idx];
      const seq = it?.kind === "user" ? it.seq : undefined;
      if (seq !== undefined) {
        setFlashSeq(seq);
        window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlashSeq(null), FLASH_MS);
      }
      return;
    }
    if (!h.cursor || jumpTries.current >= JUMP_MAX_PAGES) {
      setJumpAnchor(null); // 锚不存在(坏数据/已翻到头):放弃,不空转
      return;
    }
    if (h.loadingEarlier) return; // 本页落地(items 变化)后 effect 重跑再查
    jumpTries.current += 1;
    void h.loadEarlier(JUMP_STEP);
    // h.loadEarlier 每渲染新引用但行为稳定,刻意不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpAnchor, h.chat.items, h.cursor, h.loadingEarlier]);
  const onJumpOutline = (anchor: number) => {
    // 云端流为跟看场景:先解除贴底,否则下一批帧立刻拽回底部
    pinnedRef.current = false;
    jumpTries.current = 0;
    setJumpAnchor(anchor);
  };

  // 贴底跟随:items 变化后,若此前贴底则滚到底(useLayoutEffect 赶在绘制前)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [h.chat.items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD;
  };

  const onLoadEarlier = async () => {
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    await h.loadEarlier();
    // 前插保位:新内容把 scrollHeight 撑高多少,scrollTop 就补多少
    requestAnimationFrame(() => {
      const now = scrollRef.current;
      if (now) now.scrollTop = prevTop + (now.scrollHeight - prevHeight);
    });
  };

  const send = () => {
    pinnedRef.current = true;
    h.send();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组合期的 Enter 是选字,不是发送
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const pending = h.taskStatus === "pending";
  const connText = statusText(t, h.status);
  const statusKey = `cloud.status.${h.taskStatus}` as MessageKey;
  const statusLabel = STATUS_BADGE[h.taskStatus] ? t(statusKey) : h.taskStatus;

  return (
    <main className="relative flex min-w-0 flex-1 flex-col bg-base-100">
      <header data-view-header="" className="flex h-11 shrink-0 items-center gap-2 border-b border-base-300 px-4">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold" title={h.label}>
          {h.label}
        </h1>
        <span className={`badge badge-soft badge-sm ${STATUS_BADGE[h.taskStatus] ?? "badge-ghost"}`}>{statusLabel}</span>
        <span className="badge badge-ghost badge-sm">{t("cloud.view.badge")}</span>
        <button
          type="button"
          className={`btn btn-ghost btn-xs ${filesOpen ? "btn-active" : ""}`}
          disabled={!h.vmId}
          title={h.vmId ? undefined : t("cloud.view.filesPending")}
          onClick={() => setFilesOpen((o) => !o)}
        >
          {t("cloud.view.filesOpen")}
        </button>
        {h.vmId && !h.ended && (
          <button
            type="button"
            className={`btn btn-ghost btn-xs ${termOpen ? "btn-active" : ""}`}
            onClick={() => setTermOpen((o) => !o)}
          >
            {termOpen ? t("cloud.view.terminalClose") : t("cloud.view.terminalOpen")}
          </button>
        )}
        {!h.ended && (
          <button
            type="button"
            className={`btn btn-xs ${confirmingStop ? "btn-error" : "btn-ghost text-error"}`}
            title={t("cloud.view.stopHint")}
            onBlur={() => setConfirmingStop(false)}
            onClick={() => {
              // 危险动作二段确认:第一次点变文案,再点才停
              if (!confirmingStop) {
                setConfirmingStop(true);
                return;
              }
              setConfirmingStop(false);
              void h.stopTask();
            }}
          >
            {confirmingStop ? t("cloud.view.stopConfirm") : t("cloud.view.stop")}
          </button>
        )}
      </header>

      {pending ? (
        // 启动页:VM 准备是以分钟计的过程,整屏让给时间线(此时必无对话)
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
          <StartupTimeline meta={h.meta} />
        </div>
      ) : (
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {h.cursor && (
              <button
                type="button"
                className="btn btn-ghost btn-xs self-center"
                disabled={h.loadingEarlier}
                onClick={() => void onLoadEarlier()}
              >
                {h.loadingEarlier && <span className="loading loading-spinner loading-xs" aria-hidden />}
                {t("chat.loadEarlier")}
              </button>
            )}
            {h.chat.items.length === 0 && (
              <div className="py-10 text-center text-xs text-base-content/50">
                {h.ended ? t("cloud.view.noReplay") : (connText ?? t("cloud.conn.connecting"))}
              </div>
            )}
            {/* 审批/提问答复经 stream WS 上行(h.sendFrame),不走本地 session_send;
                包一层 div 做大纲跳转的定位根(LogList 直接子元素 ↔ items 下标) */}
            <div ref={listRef}>
              <LogList state={h.chat} sessionId={h.id} sendFrame={h.sendFrame} flashSeq={flashSeq ?? undefined} />
            </div>
          </div>
        </div>
      )}

      {/* 大纲挂在视图根(高度恒定的参照物),不挂日志视口(与 ChatView 同理) */}
      {!pending && <OutlineNav entries={entries} onJump={onJumpOutline} />}

      {/* 云端文件:右滑面板(CloudFiles 自带头部与关闭;下载走全局 downloads) */}
      {filesOpen && (
        <aside className="absolute inset-y-0 right-0 z-20 flex w-[26rem] max-w-[85%] flex-col border-l border-base-300 bg-base-100 shadow-xl">
          <CloudFiles taskId={h.id} vmId={h.ended ? undefined : h.vmId || undefined} onClose={() => setFilesOpen(false)} />
        </aside>
      )}

      <footer className="shrink-0 border-t border-base-300 p-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {termOpen && h.vmId && !h.ended && (
            <div className="flex h-64 min-h-0 flex-col overflow-hidden rounded-box border border-base-300">
              <div className="flex h-8 shrink-0 items-center gap-2 px-3" style={{ background: "var(--termHdr)" }}>
                <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--termAcc)" }} />
                <span className="text-[11px] font-semibold" style={{ color: "var(--termTx)" }}>
                  {t("cloud.view.terminalTitle")}
                </span>
                <span className="text-[11px]" style={{ color: "var(--termTx2)" }}>
                  {t("cloud.view.terminalSub")}
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  className="btn btn-ghost btn-square btn-xs"
                  aria-label={t("cloud.view.terminalClose")}
                  style={{ color: "var(--termTx2)" }}
                  onClick={() => setTermOpen(false)}
                >
                  ✕
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <CloudTerminal vmId={h.vmId} />
              </div>
            </div>
          )}

          {h.err && (
            <div role="alert" className="alert alert-error alert-soft flex items-center py-1.5 text-xs">
              <span className="min-w-0 flex-1 break-words">{h.err}</span>
              <button type="button" className="btn btn-ghost btn-xs" onClick={h.clearErr}>
                {t("chat.dismiss")}
              </button>
            </div>
          )}

          {h.running && (
            <div role="status" className="flex items-center gap-2 text-xs text-base-content/60">
              <span className="loading loading-dots loading-xs" aria-hidden />
              <span className="flex-1">{t("cloud.view.running")}</span>
              <button type="button" className="btn btn-ghost btn-xs" title={t("cloud.view.cancelRun")} onClick={h.cancelRun}>
                {t("chat.stop")}
              </button>
            </div>
          )}

          {connText && !h.ended && (
            <div role="status" className="flex items-center gap-1.5 text-[11px] text-base-content/50">
              <span aria-hidden className={`status status-xs ${h.connected ? "status-success" : ""}`} />
              <span className="min-w-0 truncate">{connText}</span>
            </div>
          )}

          {h.ended ? (
            <div className="py-1 text-center text-xs text-base-content/50">{t("cloud.view.readonly")}</div>
          ) : (
            <div className="flex items-end gap-2">
              <textarea
                aria-label={t("chat.composer")}
                className="textarea min-h-10 w-full resize-none text-sm"
                rows={2}
                placeholder={pending ? t("cloud.view.composerPending") : t("cloud.view.composerPlaceholder")}
                value={h.input}
                onChange={(e) => h.setInput(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={pending}
              />
              <button type="button" className="btn btn-primary btn-sm" disabled={pending || !h.input.trim()} onClick={send}>
                {t("chat.send")}
              </button>
            </div>
          )}
        </div>
      </footer>
    </main>
  );
}
