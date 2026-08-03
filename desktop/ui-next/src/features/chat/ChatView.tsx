// 聊天视图:header(标题+摘要+连接态)+ 消息流(贴底跟随/加载更早保位)+
// 提问大纲(左缘点列,跳转补页)+ 任务面板 + 全功能 composer(P3d)。
// 滚动策略:贴底时新内容自动跟随,用户上滚即解除;"加载更早"前插后按
// scrollHeight 差值补偿 scrollTop,视口纹丝不动。
// 大纲跳转:锚(data-user-seq)不在 DOM 时循环 loadEarlier 补页——用
// effect 驱动(每页提交后重查),不赌 React 提交时序;上限重试防死循环。
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";

import { useApprovalHotkeys } from "@/app/shortcuts";
import { useI18n } from "@/lib/i18n";
import { sessionOutline, type OutlineItem } from "@/lib/ipc/controls";
import type { SessionMeta } from "@/lib/ipc/sessions";
import { onNativeFileDrop } from "@/lib/ipc/uploads";
import { Composer } from "./composer/Composer";
import { useComposer } from "./composer/useComposer";
import { LogList } from "./LogList";
import { OutlineNav, outlineEntriesOf } from "./OutlineNav";
import { TaskPanel } from "./TaskPanel";
import { FilesDrawer } from "@/features/files/FilesDrawer";
import { useSessionFeed } from "./useSessionFeed";

const PIN_THRESHOLD = 40; // 距底多少像素内算"贴底"
const JUMP_MAX_PAGES = 80; // 大纲跳转补页上限(cursor 不前进/坏锚时不空转)
const FLASH_MS = 1100; // 与 chrome.css mc-flash 动画时长对齐(略长于 1s)

export function ChatView({ meta }: { meta: SessionMeta }) {
  const { t } = useI18n();
  const { state, conn, hasMore, loadingEarlier, loadEarlier } = useSessionFeed(meta.id);
  useApprovalHotkeys(state, meta.id);
  const composer = useComposer(meta.id, state.running);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // 贴底跟随:items 变化后,若此前贴底则滚到底(useLayoutEffect 赶在绘制前)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [state.items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD;
  };

  const onLoadEarlier = async () => {
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    await loadEarlier();
    // 前插保位:新内容把 scrollHeight 撑高多少,scrollTop 就补多少
    requestAnimationFrame(() => {
      const now = scrollRef.current;
      if (now) now.scrollTop = prevTop + (now.scrollHeight - prevHeight);
    });
  };

  // 发送被接受(发出或排队)即回到贴底跟随
  const followBottom = () => {
    pinnedRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // ==== 提问大纲:打开拉一次,轮结束(running 真→假)再拉(轮末才物化) ====
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  useEffect(() => {
    let alive = true;
    setOutline([]);
    void sessionOutline(meta.id).then((items) => {
      if (alive) setOutline(items);
    });
    return () => {
      alive = false;
    };
  }, [meta.id]);
  const prevRunning = useRef(false);
  useEffect(() => {
    const was = prevRunning.current;
    prevRunning.current = state.running;
    if (!was || state.running) return;
    let alive = true;
    void sessionOutline(meta.id).then((items) => {
      if (alive) setOutline(items);
    });
    return () => {
      alive = false;
    };
  }, [state.running, meta.id]);
  const entries = useMemo(() => outlineEntriesOf(outline, state.items), [outline, state.items]);

  // ==== 大纲跳转:effect 驱动的补页循环 + 目标气泡闪光 ====
  const [jumpSeq, setJumpSeq] = useState<number | null>(null);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  const jumpTries = useRef(0);
  const flashTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  useEffect(() => {
    if (jumpSeq === null) return;
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-user-seq="${jumpSeq}"]`);
    if (node) {
      pinnedRef.current = false;
      node.scrollIntoView?.({ block: "start" });
      setJumpSeq(null);
      setFlashSeq(jumpSeq);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlashSeq(null), FLASH_MS);
      return;
    }
    if (!hasMore || jumpTries.current >= JUMP_MAX_PAGES) {
      setJumpSeq(null); // 锚不存在(坏 seq/历史被清):放弃,不空转
      return;
    }
    if (loadingEarlier) return; // 本页落地(items 变化)后 effect 重跑再查
    jumpTries.current += 1;
    void loadEarlier();
  }, [jumpSeq, state.items, hasMore, loadingEarlier, loadEarlier]);
  const onJump = (seq: number) => {
    jumpTries.current = 0;
    setJumpSeq(seq);
  };

  // ==== 拖拽附件:HTML5 事件(dragenter/leave 计数配对)+ Linux 壳原生事件 ====
  const [dragging, setDragging] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [changesToken, setChangesToken] = useState(0);
  const prevTurnEnded = useRef(false);
  useEffect(() => {
    // 轮次结束边沿:改动列表需要重拉(抽屉开着时立即,关着时下次打开取新)
    if (state.turnEnded && !prevTurnEnded.current) setChangesToken((n) => n + 1);
    prevTurnEnded.current = state.turnEnded;
  }, [state.turnEnded]);
  const dragDepth = useRef(0);
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const onDragEnter = (e: DragEvent<HTMLElement>) => {
    if (![...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (--dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void composerRef.current.addFiles(files);
  };
  // Linux 壳:WebKitGTK 的 HTML5 拖拽拿不到 File,走壳原生 tauri://drag-*
  // (mac/Windows 壳禁用原生处理器,监听永不触发)
  useEffect(
    () =>
      onNativeFileDrop({
        onDragging: setDragging,
        onFiles: (files) => void composerRef.current.addFiles(files),
        onError: (m) => composerRef.current.notifyError(t("chat.uploadFailed", { reason: m })),
      }),
    // t 稳定(模块级函数);按会话重订阅即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta.id],
  );

  return (
    <main
      className="relative flex min-w-0 flex-1 flex-col bg-base-100"
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-box border-2 border-dashed border-primary bg-primary/10 text-sm font-semibold text-primary">
          {t("chat.dropHint")}
        </div>
      )}

      <header data-view-header="" className="flex h-11 shrink-0 items-center gap-2 border-b border-base-300 px-4">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm leading-tight font-semibold">{meta.title}</h1>
          {meta.summary && (
            <p className="truncate text-[11px] leading-tight text-base-content/50">{meta.summary}</p>
          )}
        </div>
        {conn && !conn.connected && (
          <span className="badge badge-warning badge-soft badge-sm">{conn.text}</span>
        )}
        <button
          type="button"
          aria-label={t("files.label")}
          title={t("files.label")}
          className="btn btn-ghost btn-square btn-sm text-base-content/60"
          onClick={() => setDrawerOpen((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
            <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" />
          </svg>
        </button>
        {state.usage && state.usage.size > 0 && (
          <span
            className="font-mono text-[11px] text-base-content/40 tabular-nums"
            title={t("chat.contextUsage")}
          >
            {Math.round((state.usage.used / state.usage.size) * 100)}%
          </span>
        )}
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {hasMore && (
            <button type="button" className="btn btn-ghost btn-xs self-center" disabled={loadingEarlier} onClick={() => void onLoadEarlier()}>
              {loadingEarlier && <span className="loading loading-spinner loading-xs" aria-hidden />}
              {t("chat.loadEarlier")}
            </button>
          )}
          <LogList state={state} sessionId={meta.id} flashSeq={flashSeq ?? undefined} />
        </div>
      </div>

      {/* 大纲挂在视图根(高度恒定的参照物),不挂日志视口:下方任务面板/
          排队条长高会压矮视口,居中点列跟着跳 */}
      <OutlineNav entries={entries} onJump={onJump} />

      <footer className="shrink-0 border-t border-base-300 p-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {state.plan.length > 0 && <TaskPanel entries={state.plan} />}
          <Composer sessionId={meta.id} state={state} meta={meta} ctl={composer} onAfterSend={followBottom} />
        </div>
      </footer>
      {drawerOpen && (
        <FilesDrawer sessionId={meta.id} onClose={() => setDrawerOpen(false)} refreshToken={changesToken} />
      )}
    </main>
  );
}
