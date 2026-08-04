// 聊天视图:header(标题+摘要+连接态)+ 消息流(贴底跟随/加载更早保位)+
// 提问大纲(左缘点列,跳转补页)+ 任务面板 + 全功能 composer(P3d)。
// 滚动策略:贴底时新内容自动跟随,用户上滚即解除;"加载更早"前插后按
// scrollHeight 差值补偿 scrollTop,视口纹丝不动。
// 大纲跳转:锚(data-user-seq)不在 DOM 时循环 loadEarlier 补页——用
// effect 驱动(每页提交后重查),不赌 React 提交时序;上限重试防死循环。
import { FolderOpen, X } from "lucide-react";
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
import { sessionPatch, type SessionMeta } from "@/lib/ipc/sessions";
import { onNativeFileDrop } from "@/lib/ipc/uploads";
import { createImeGuard } from "@/lib/util/slash";
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

export function ChatView({ meta, epoch = 0 }: { meta: SessionMeta; epoch?: number }) {
  const { t } = useI18n();
  const { state, conn, hasMore, loadingEarlier, loadEarlier } = useSessionFeed(meta.id, epoch);
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

  // ==== 标题重命名(D4):h1 双击进输入态。提交只发 sessionPatch,不乐观
  // 改 meta——壳广播 session-event,App 的列表 patch 回写 title 后新 meta
  // 自然流回来。Enter 提交(IME 选字回车除外)/Esc 放弃/失焦提交。 ====
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleIme = useRef(createImeGuard());
  // 提交/放弃后置位:Enter 提交会卸载输入框,随之而来的 blur 不能再提交一次
  const renameDoneRef = useRef(false);
  const startRename = () => {
    setTitleDraft(meta.title);
    renameDoneRef.current = false;
    setEditingTitle(true);
  };
  const commitRename = () => {
    if (renameDoneRef.current) return;
    renameDoneRef.current = true;
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (next && next !== meta.title) void sessionPatch(meta.id, { title: next }).catch(() => {});
  };
  const cancelRename = () => {
    renameDoneRef.current = true;
    setEditingTitle(false);
  };
  useEffect(() => {
    // 切会话丢弃编辑态(草稿属于上一个会话)
    setEditingTitle(false);
  }, [meta.id]);

  // ==== 子代理会话回放浮层(D2):工具卡「查看子会话」入口打开,只读 ====
  const [childId, setChildId] = useState<string | null>(null);
  useEffect(() => {
    setChildId(null); // 切会话关掉上一个会话的子回放
  }, [meta.id]);

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

      <header data-view-header="" data-tauri-drag-region="" className="flex h-13 shrink-0 items-center gap-2 border-b border-base-300 px-4">
        <div data-tauri-drag-region="" className="min-w-0 flex-1">
          {editingTitle ? (
            <input
              autoFocus
              aria-label={t("chat.rename.label")}
              className="input input-xs w-full max-w-xs text-sm font-semibold"
              value={titleDraft}
              maxLength={80}
              onChange={(e) => setTitleDraft(e.target.value)}
              // 进编辑态即全选(Finder 改名手感:直接打字整体覆盖)
              onFocus={(e) => e.currentTarget.select()}
              onCompositionEnd={(e) => titleIme.current.markEnd(e.timeStamp)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                // 输入态按键不外溢:Esc/Enter 属于改名交互,不能漏给全局
                // 审批热键(esc=deny 不可逆)
                e.stopPropagation();
                if (e.key === "Enter" && !titleIme.current.isImeEnter(e.timeStamp, e.nativeEvent.isComposing)) {
                  commitRename();
                } else if (e.key === "Escape") {
                  cancelRename();
                }
              }}
            />
          ) : (
            <h1 data-tauri-drag-region="" className="truncate text-sm leading-tight font-semibold">
              {/* 双击只挂在文字 span 上,且不带 data-tauri-drag-region:
                  Windows 壳把拖拽区双击吃成最大化,标题必须留在拖拽区之外 */}
              <span title={t("chat.rename.hint")} className="cursor-text" onDoubleClick={startRename}>
                {meta.title}
              </span>
            </h1>
          )}
          {/* 副标题:有摘要显摘要;无摘要时 chat 会话标「独立会话」、其余
              显 workdir 末段(mono,悬停看全路径)——一眼可辨会话归属 */}
          {meta.summary ? (
            <p data-tauri-drag-region="" className="truncate text-[11px] leading-tight text-base-content/50">{meta.summary}</p>
          ) : meta.kind === "chat" ? (
            <p data-tauri-drag-region="" className="truncate text-[11px] leading-tight text-base-content/45">{t("chat.header.standalone")}</p>
          ) : meta.workdir ? (
            <p data-tauri-drag-region="" title={meta.workdir} className="truncate font-mono text-[11px] leading-tight text-base-content/45">
              {meta.workdir.split(/[\\/]/).filter(Boolean).pop() ?? meta.workdir}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={t("files.label")}
          title={t("files.label")}
          className="btn btn-ghost btn-square btn-sm text-base-content/60"
          onClick={() => setDrawerOpen((v) => !v)}
        >
          <FolderOpen size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </header>

      {/* 布局规范:header 只放身份与动作;会话连接状态是内容级信息,
          以内嵌条挂在 header 之下,恢复即消 */}
      {conn && !conn.connected && (
        <div role="status" className="alert alert-warning alert-soft shrink-0 rounded-none py-1.5 text-xs">
          <span aria-hidden className="status status-warning status-xs animate-pulse" />
          <span className="min-w-0 flex-1 truncate" title={conn.text}>{conn.text}</span>
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {hasMore && (
            <button type="button" className="btn btn-ghost btn-xs self-center" disabled={loadingEarlier} onClick={() => void onLoadEarlier()}>
              {loadingEarlier && <span className="loading loading-spinner loading-xs" aria-hidden />}
              {t("chat.loadEarlier")}
            </button>
          )}
          <LogList state={state} sessionId={meta.id} flashSeq={flashSeq ?? undefined} onOpenChildSession={setChildId} />
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
      {childId && <ChildSessionModal id={childId} onClose={() => setChildId(null)} />}
    </main>
  );
}

/** 子代理会话只读回放浮层(D2):复用 useSessionFeed + LogList(readonly),
 * 无 composer、无审批热键;卸载即 session_close(useSessionFeed 清理)。
 * 尾部回放窗口够看完整过程,不做「加载更早」(与旧版 SessionViewer 同口径)。 */
function ChildSessionModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const { state } = useSessionFeed(id);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    // Esc(window capture):浮层优先——消费即截断,不许漏给全局审批热键
    // (esc = deny 不可逆;语义与 FilesDrawer 一致)
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);
  return (
    <div className="modal modal-open" role="dialog" aria-label={t("chat.child.title")}>
      <div className="modal-box flex max-h-[84vh] w-[min(860px,92vw)] max-w-[min(860px,92vw)] flex-col gap-3 p-5">
        <div className="flex shrink-0 items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {t("chat.child.title")} <span className="font-mono text-xs text-base-content/50">{id}</span>
          </h2>

          <button
            type="button"
            aria-label={t("chat.dismiss")}
            title={t("chat.dismiss")}
            className="btn btn-ghost btn-square btn-xs"
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <LogList state={state} sessionId={id} readonly />
        </div>
      </div>
      <div className="modal-backdrop cursor-pointer" onClick={onClose} aria-hidden />
    </div>
  );
}
