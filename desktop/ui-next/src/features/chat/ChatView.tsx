// 聊天视图:header(标题+摘要+连接态)+ 消息流(贴底跟随/滚动记忆/加载
// 更早保位)+ 提问大纲(左缘点列,跳转补页)+ 任务面板 + 全功能 composer。
// 滚动策略(旧 UI chat.tsx 的滚动纪律移植):
// - 贴底判定单向:scroll 事件只做「进入贴底 → 跟随」;解除跟随只认真实
//   用户输入(wheel 上滚 / 右缘 mousedown 拖滚动条),程序滚动不误判;
// - 会话滚动记忆:卸载/切会话写档「视口顶条目 + 条目内偏移 + pinned」,
//   回来按锚点恢复(纯函数在 lib/util/scrollAnchor,几何可测);
// - 「加载更早」前插保位记**元素**,提交后 layoutEffect 对齐回原视口位。
// 大纲跳转:锚(data-user-seq)不在 DOM 时按条目 offset 走 ensureLoaded
// 精确补页(session_history 以 offset 为终点,不盲翻),补页提交前的空窗
// 用短时重试兜(旧 chat.tsx jumpWithRetry 语义);大纲当前项 activeSeq 由
// rAF 节流的滚动跟踪算出(lib/util/scrollAnchor.outlineActiveSeq)。
import { Ellipsis, FolderOpen, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { useApprovalHotkeys } from "@/app/shortcuts";
import { useI18n } from "@/lib/i18n";
import { sessionOutline, type OutlineItem } from "@/lib/ipc/controls";
import { repoChanges, repoReveal } from "@/lib/ipc/repo";
import { sessionFrame, sessionPatch, type SessionMeta } from "@/lib/ipc/sessions";
import { onNativeFileDrop, uploadFileURL } from "@/lib/ipc/uploads";
import { workspaceRelativePath } from "@/lib/util/markdownPaths";
import { anchorScrollTop, findAnchor, outlineActiveSeq } from "@/lib/util/scrollAnchor";
import { createImeGuard } from "@/lib/util/slash";
import { useDismiss } from "@/lib/util/useDismiss";
import { Composer } from "./composer/Composer";
import { useComposer } from "./composer/useComposer";
import { LogList } from "./LogList";
import { OutlineNav, outlineEntriesOf } from "./OutlineNav";
import { TaskPanel } from "./TaskPanel";
import { FilesDrawer } from "@/features/files/FilesDrawer";
import { useSessionFeed } from "./useSessionFeed";

const PIN_THRESHOLD = 40; // 距底多少像素内算"贴底"(scroll 只做进入贴底的单向判定)
const SCROLLBAR_EDGE = 18; // 视口右缘按下算滚动条拖拽意图,解除跟随
const RESTORE_POLLS = 15; // 锚点恢复的轮询校准次数(200ms 一次,3s 内收敛)
const FLASH_MS = 1100; // 与 chrome.css mc-flash 动画时长对齐(略长于 1s)

// 各会话的滚动位置记忆:切走再切回仍在原位;贴底离开的会话回来仍贴底。
// 记「视口顶部的条目序号 + 条目内偏移」而非 scrollTop 像素:历史分批回放、
// 工具结果合并进先前条目、折叠态重置都会改变上方内容高度,像素值会漂,
// 锚点跟着条目走才对得上"看到哪了"。ChatView 本身会因设置页等视图切换
// 整体卸载重挂,记忆只能存在模块级(旧 UI chat.tsx 同款设计,理由随迁)。
const scrollMemo = new Map<string, { anchor: number; offset: number; pinned: boolean }>();

export function ChatView({
  meta,
  epoch = 0,
  onDeleted,
}: {
  meta: SessionMeta;
  epoch?: number;
  /** ⋯ 菜单二段确认后的删除动作:通知 App 走与侧栏同一套删除流程 */
  onDeleted?: () => void;
}) {
  const { t } = useI18n();
  const { state, conn, hasMore, loadingEarlier, earlierError, loadEarlier, ensureLoaded } = useSessionFeed(meta.id, epoch);
  useApprovalHotkeys(state, meta.id);
  const composer = useComposer(meta.id, state.running);
  // 稳定引用:传给 memo 化 LogList 的回调、拖拽/原生落盘回调都经它取最新
  // ctl,不随 composer 对象每渲染换新
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // 用户是否停留在底部(自动跟随滚动)
  // 待恢复的锚点;回放期间每批都重新对齐(上方内容变高也不漂),用户主动滚动后交还控制权
  const restoreRef = useRef<{ anchor: number; offset: number } | null>(null);
  const restoreTimer = useRef(0);
  const restoreTicks = useRef(0);
  const restoreRO = useRef<ResizeObserver | null>(null);
  const saveTimer = useRef(0);

  // 滚动容器 → 条目列:LogList 根节点恒为内容轨(firstElementChild)的
  // 最后一个子元素,其 children 与 state.items 一一对应(LogList 结构契约)
  const itemColOf = () => scrollRef.current?.firstElementChild?.lastElementChild ?? null;
  // 各条目相对滚动内容的 top 序列(content 坐标,与当前 scrollTop 无关)
  const itemTops = (el: HTMLElement): number[] => {
    const col = itemColOf();
    if (!col) return [];
    const base = el.getBoundingClientRect().top - el.scrollTop;
    return Array.from(col.children, (kid) => kid.getBoundingClientRect().top - base);
  };

  // 自动滚动:优先对齐待恢复锚点,否则贴底跟随。锚点条目还没回放出来时
  // 先不动(停在已回放内容的开头),出来后逐批对齐
  const align = () => {
    const el = scrollRef.current;
    if (!el) return;
    const a = restoreRef.current;
    if (a) {
      const tops = itemTops(el);
      if (a.anchor < tops.length) el.scrollTop = anchorScrollTop(tops, a.anchor, a.offset);
    } else if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  };

  // 恢复完成/用户接管:轮询与 RO 兜底一并解除,交还滚动控制权
  const finishRestore = () => {
    restoreRef.current = null;
    window.clearInterval(restoreTimer.current);
    restoreTimer.current = 0;
    restoreRO.current?.disconnect();
    restoreRO.current = null;
  };

  // 锚点恢复:立即对齐 + 200ms 轮询校准若干次——内容分批物化、渲染后布局
  // 还会无事件地微调(实测 ~6px,RO 也抓不到这种再分配),对齐到位后只是
  // 零修正的空转;另挂 ResizeObserver 监听内容列兜底(图片解码/字体加载
  // 会把位置顶漂几 px,不经过 items 变化)。恢复结束二者一并解除。
  const startRestore = (anchor: number, offset: number) => {
    finishRestore();
    restoreRef.current = { anchor, offset };
    align();
    restoreTicks.current = 0;
    restoreTimer.current = window.setInterval(() => {
      if (!restoreRef.current || ++restoreTicks.current > RESTORE_POLLS) {
        finishRestore();
        return;
      }
      align();
    }, 200);
    const col = itemColOf();
    if (col && typeof ResizeObserver !== "undefined") {
      restoreRO.current = new ResizeObserver(align);
      restoreRO.current.observe(col);
    }
  };

  // 写档当前位置。恢复进行中的程序滚动不写记忆:中途切走时锚点不能被
  // 半成品覆盖;已脱离文档(卸载竞态)也不写,免得好档被零几何冲掉
  const saveAnchor = () => {
    const el = scrollRef.current;
    if (!el || !el.isConnected || restoreRef.current) return;
    const { anchor, offset } = findAnchor(itemTops(el), el.scrollTop);
    scrollMemo.set(meta.id, { anchor, offset, pinned: pinnedRef.current });
  };

  // 会话切换/挂载:复位跟随状态并取出记忆位置(不显式复位的话 pinnedRef
  // 会带着上一会话的值进入新会话);cleanup 时 DOM 仍在,写档旧会话位置,
  // 并把旧会话的轮询定时器/RO 清干净
  useLayoutEffect(() => {
    const saved = scrollMemo.get(meta.id);
    pinnedRef.current = saved ? saved.pinned : true; // 首次打开默认贴底
    if (saved && !saved.pinned) startRestore(saved.anchor, saved.offset);
    else {
      restoreRef.current = null;
      align();
    }
    return () => {
      saveAnchor();
      finishRestore();
      window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id]);

  // items 变化后赶在绘制前对齐(锚点恢复或贴底跟随)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(align, [state.items, state.running]);

  // scroll 事件只做「贴底 → 跟随」的单向判定,离底不在这里判:程序滚动
  // 同样发 scroll 事件,回放中一批内容长高就会把跟随误判成用户离底(实测
  // 卡在中途)。离底判定只认用户真实输入(onWheel 上滚/右缘 mousedown)
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD) pinnedRef.current = true;
    saveAnchor();
    scheduleActive();
    // 滚动停止后布局仍会微调一次(不发 scroll 事件),停稳后补一次写档
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(saveAnchor, 600);
  };

  // 用户主动介入即终止锚点恢复,交还滚动控制权;向上意图同时解除贴底跟随
  const onLogWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    finishRestore();
    if (e.deltaY < 0) pinnedRef.current = false; // 向上滚 = 离开底部去看历史
  };
  const onLogMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    finishRestore();
    // 按在右缘滚动条带上 = 准备拖动定位,解除跟随(拖回底部经 scroll 事件重新贴上)
    const el = scrollRef.current;
    if (el && e.clientX > el.getBoundingClientRect().right - SCROLLBAR_EDGE) pinnedRef.current = false;
  };

  // 「加载更早」的位置保持:前插会把所有条目往下推,记像素没用,记**元素**
  // ——keyBase 稳定 key 保证 React 不会把既有条目换成新节点,前插提交后按
  // 同一元素重新对齐,视口纹丝不动
  const prependAnchor = useRef<{ node: Element; offset: number } | null>(null);
  const onLoadEarlier = async () => {
    pinnedRef.current = false;
    const el = scrollRef.current;
    const col = itemColOf();
    if (el && col) {
      const elTop = el.getBoundingClientRect().top;
      for (const kid of Array.from(col.children)) {
        const r = kid.getBoundingClientRect();
        if (r.bottom > elTop) {
          prependAnchor.current = { node: kid, offset: elTop - r.top };
          break;
        }
      }
    }
    await loadEarlier();
  };
  // 用 layout effect:DOM 已更新但尚未绘制,这一帧就把位置纠回去,不闪
  useLayoutEffect(() => {
    const pa = prependAnchor.current;
    if (!pa) return;
    prependAnchor.current = null;
    const col = itemColOf();
    const idx = col ? Array.prototype.indexOf.call(col.children, pa.node) : -1;
    if (idx >= 0) startRestore(idx, pa.offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.items]);

  // 发送被接受(发出或排队)即回到贴底跟随:这次发送本身就是回到当前轮次
  // 的明确意图,立即结束锚点恢复并重新贴底
  const followBottom = () => {
    finishRestore();
    pinnedRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // markdown 工作区文件链接:判界(工作区外拒绝)→ repo_reveal 文件管理器
  // 定位;失败走 composer 提示条(§3:会话内操作失败的法定位置)。
  // useCallback + 下面两个回读通道同理:LogList 已 memo,打字每敲一键
  // ChatView 都重渲染,内联箭头函数会把整条消息流(每条 markdown 卡)
  // 一起拖着重渲染——输入手感卡顿的根因
  const revealMarkdownLink = useCallback(
    (path: string) => {
      const rel = workspaceRelativePath(path, meta.workdir);
      if (rel === null) {
        composerRef.current.notifyError(t("chat.revealOutside"));
        return;
      }
      void repoReveal(meta.id, rel).catch((e: unknown) => {
        composerRef.current.notifyError(t("chat.revealFailed", { reason: e instanceof Error ? e.message : String(e) }));
      });
    },
    [meta.id, meta.workdir, t],
  );
  const uploadUrl = useCallback((p: string) => uploadFileURL(meta.id, p), [meta.id]);
  const loadFullTool = useCallback((seq: number) => sessionFrame(meta.id, seq), [meta.id]);

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

  // ==== 头部 ⋯ 菜单(重命名/归档/删除):受控 dropdown,外点/Esc 即收
  // (pointerdown 判定,不吃 WebKitGTK 按钮不获焦的亏;Esc window capture
  // 截断,不落进全局审批链——手法与 Composer 两个 picker 一致,见
  // lib/util/useDismiss)。删除走二段确认(首点变「确认删除?」,再点才经
  // onDeleted 通知 App)。 ====
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuBoxRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = () => {
    setMenuOpen(false);
    setConfirmDelete(false);
  };
  useDismiss(menuOpen, menuBoxRef, closeMenu);
  useEffect(() => {
    // 切会话收起菜单(确认态属于上一个会话)
    closeMenu();
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

  // ==== 当前项跟踪:视口顶所在的提问(rAF 节流——流式期间每批帧都重算
  // 会把点列刷成动画;判定纯函数在 lib/util/scrollAnchor,与跳转 INSET
  // 同一条线) ====
  const [activeSeq, setActiveSeq] = useState<number | null>(null);
  const activeRaf = useRef(0);
  const updateActive = () => {
    const el = scrollRef.current;
    if (!el) return;
    const seqTops = Array.from(el.querySelectorAll<HTMLElement>("[data-user-seq]"), (node) => ({
      seq: Number(node.dataset.userSeq),
      top: node.getBoundingClientRect().top,
    })).filter((it) => Number.isFinite(it.seq));
    setActiveSeq(outlineActiveSeq(seqTops, el.getBoundingClientRect().top));
  };
  const scheduleActive = () => {
    if (activeRaf.current) return;
    activeRaf.current = window.requestAnimationFrame(() => {
      activeRaf.current = 0;
      updateActive();
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(scheduleActive, [state.items]);
  // 取消后必须把 id 清零:scheduleActive 以「非零 = 已排队」做节流,残留
  // 旧 id 会让它永远短路(StrictMode 双挂载即触发,当前项从此不再更新)
  useEffect(
    () => () => {
      window.cancelAnimationFrame(activeRaf.current);
      activeRaf.current = 0;
    },
    [],
  );

  // ==== 大纲跳转:offset 精确补页 + 目标气泡闪光 ====
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  const flashTimer = useRef(0);
  const jumpTimer = useRef(0);
  useEffect(
    () => () => {
      window.clearTimeout(flashTimer.current);
      window.clearTimeout(jumpTimer.current);
    },
    [],
  );
  /** 定位到某次提问;锚还没渲染进 DOM 返回 false。 */
  const jumpToSeq = (seq: number): boolean => {
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-user-seq="${seq}"]`);
    if (!node) return false;
    finishRestore(); // 跳转接管滚动:进行中的锚点恢复轮询不许再拽回去
    pinnedRef.current = false;
    node.scrollIntoView?.({ block: "start" });
    setFlashSeq(seq);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashSeq(null), FLASH_MS);
    return true;
  };
  // 补页后的锚要等 React 提交才进 DOM,短时重试兜时序(旧 chat.tsx
  // jumpWithRetry 随迁);重试耗尽 = 坏 seq/历史被清,放弃不空转
  const jumpWithRetry = (seq: number, tries = 12) => {
    if (jumpToSeq(seq) || tries <= 0) return;
    jumpTimer.current = window.setTimeout(() => jumpWithRetry(seq, tries - 1), 32);
  };
  const onJump = (seq: number, offset?: number) => {
    if (jumpToSeq(seq)) return;
    // 更早的提问还没加载:按它那一轮的 offset 精确补页再定位(session_history
    // 以 offset 为终点);流内新条目无 offset(按理已在 DOM),只走重试兜底
    if (offset !== undefined) void ensureLoaded(offset).then(() => jumpWithRetry(seq));
    else jumpWithRetry(seq);
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
  // 改动数徽标:轮末(changesToken 边沿)拉一次计数;浏览器模式 repoChanges
  // 自身降级空值,失败静默归零(徽标是提示,不是错误面)。徽标 >0 时点
  // 文件钮直达抽屉「改动」页。
  const [changesCount, setChangesCount] = useState(0);
  useEffect(() => {
    setChangesCount(0); // 徽标属于会话,切走清零
  }, [meta.id]);
  useEffect(() => {
    if (changesToken === 0) return;
    let alive = true;
    repoChanges(meta.id).then(
      (r) => {
        if (alive) setChangesCount(r.changes.length);
      },
      () => {
        if (alive) setChangesCount(0);
      },
    );
    return () => {
      alive = false;
    };
  }, [changesToken, meta.id]);
  const dragDepth = useRef(0);
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

  // ==== 空态(旧 chat.tsx 同款信息设计:logo + 主句 + 副句):items 空且
  // 非 running 才算空;chat 会话(无 workdir)与本地任务两版文案。本地版
  // 主句内嵌 mono workdir——模板留 {dir} 占位,渲染时拆开插 span。 ====
  const empty = state.items.length === 0 && !state.running;
  const emptyChat = !meta.workdir;
  const [emptyTitlePre, emptyTitlePost] = t("chat.empty.taskTitle").split("{dir}");

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
            /* 单行标题(用户定案 2026-08-06,撤两行):用户改名 > 轮末摘要 >
               首句自动标题(title_custom 区分改名与自动,壳 sidecar 标记);
               双击改名改的始终是 title。悬停 tooltip 带全量(标题/摘要/目录) */
            <h1 data-tauri-drag-region="" className="truncate text-sm leading-tight font-semibold">
              {/* 双击只挂在文字 span 上,且不带 data-tauri-drag-region:
                  Windows 壳把拖拽区双击吃成最大化,标题必须留在拖拽区之外 */}
              <span
                title={[meta.title, meta.summary, meta.workdir, t("chat.rename.hint")].filter(Boolean).join("\n")}
                className="cursor-text"
                onDoubleClick={startRename}
              >
                {meta.title_custom ? meta.title : meta.summary || meta.title}
              </span>
            </h1>
          )}
        </div>
        {/* §7:indicator 壳与徽标是头部非交互子节点,必须各自带拖拽属性 */}
        <div data-tauri-drag-region="" className={changesCount > 0 ? "indicator" : undefined}>
          {changesCount > 0 && (
            <span data-tauri-drag-region="" className="indicator-item badge badge-primary badge-xs">
              {changesCount}
            </span>
          )}
          <button
            type="button"
            aria-label={t("files.label")}
            title={t("files.label")}
            className="btn btn-ghost btn-square btn-sm text-base-content/60"
            onClick={() => setDrawerOpen((v) => !v)}
          >
            <FolderOpen size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div ref={menuBoxRef} className={`dropdown dropdown-end ${menuOpen ? "dropdown-open" : ""}`}>
          <button
            type="button"
            aria-label={t("chat.menu.label")}
            title={t("chat.menu.label")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="btn btn-ghost btn-square btn-sm text-base-content/60"
            onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          >
            <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
          </button>
          {menuOpen && (
            <ul role="menu" aria-label={t("chat.menu.label")} className="dropdown-content menu z-40 w-44 flex-nowrap [&_li]:flex-nowrap rounded-box bg-base-100 p-2 shadow-sm">
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    startRename();
                  }}
                >
                  {t("chat.menu.rename")}
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    void sessionPatch(meta.id, { archived: !meta.archived }).catch(() => {});
                  }}
                >
                  {meta.archived ? t("chat.menu.unarchive") : t("chat.menu.archive")}
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={confirmDelete ? "text-error" : ""}
                  onClick={() => {
                    // 危险动作二段确认:首点只变文案,再点才执行(同 CloudTaskView 停止钮)
                    if (!confirmDelete) {
                      setConfirmDelete(true);
                      return;
                    }
                    closeMenu();
                    onDeleted?.();
                  }}
                >
                  {confirmDelete ? t("chat.menu.deleteConfirm") : t("chat.menu.delete")}
                </button>
              </li>
            </ul>
          )}
        </div>
      </header>

      {/* 布局规范:header 只放身份与动作;会话连接状态是内容级信息,
          以内嵌条挂在 header 之下,恢复即消。形态 = 「header 的延长线」:
          同 px-4 内距(文字与标题同一竖线)、同 border-b 分隔线、微量
          warning 底,不用 alert 横幅(环境态是低声耳语,不是警报);
          文案由壳带来(恢复中/恢复失败),warning 点保持状态中立 */}
      {conn && !conn.connected && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-base-300 bg-warning/5 px-4 py-1.5 text-xs text-base-content/70">
          <span aria-hidden className="status status-warning status-sm animate-pulse shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={conn.text}>{conn.text}</span>
        </div>
      )}

      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
          <img src="/logo.png" alt="" aria-hidden className="h-13 w-13 rounded-2xl shadow-sm" />
          <p className="max-w-md text-center text-base font-bold">
            {emptyChat ? (
              t("chat.empty.chatTitle")
            ) : (
              <>
                {emptyTitlePre}
                <span className="font-mono text-sm whitespace-nowrap">{meta.workdir}</span>
                {emptyTitlePost}
              </>
            )}
          </p>
          <p className="max-w-md text-center text-xs leading-relaxed text-base-content/60">
            {emptyChat ? t("chat.empty.chatDetail") : t("chat.empty.taskDetail")}
          </p>
        </div>
      ) : (
      <div
        ref={scrollRef}
        data-chat-log=""
        onScroll={onScroll}
        onWheel={onLogWheel}
        onMouseDown={onLogMouseDown}
        // scrollbar-gutter 两侧对称预留:经典滚动条(chrome.css 8px)只占
        // 右侧时,内部居中列会整体左偏 4px,与页脚 composer 列(无滚动条,
        // 真中线)对不齐——对称留槽让两列共享同一条中线
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3 [scrollbar-gutter:stable_both-edges]"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {hasMore && (
            <button type="button" className="btn btn-ghost btn-xs self-center" disabled={loadingEarlier} onClick={() => void onLoadEarlier()}>
              {loadingEarlier && <span className="loading loading-spinner loading-xs" aria-hidden />}
              {t("chat.loadEarlier")}
            </button>
          )}
          {earlierError && (
            <p role="status" className="self-center text-xs text-error">
              {t("chat.loadEarlierFailed", { reason: earlierError })}
            </p>
          )}
          <LogList
            state={state}
            sessionId={meta.id}
            flashSeq={flashSeq ?? undefined}
            onOpenChildSession={setChildId}
            uploadUrl={uploadUrl}
            onLocalLink={revealMarkdownLink}
            workdir={meta.workdir}
            loadFullTool={loadFullTool}
          />
        </div>
      </div>
      )}

      {/* 大纲挂在视图根(高度恒定的参照物),不挂日志视口:下方任务面板/
          排队条长高会压矮视口,居中点列跟着跳 */}
      <OutlineNav entries={entries} activeSeq={activeSeq ?? undefined} onJump={onJump} />

      <footer className="shrink-0 border-t border-base-300 p-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {state.plan.length > 0 && <TaskPanel entries={state.plan} />}
          <Composer sessionId={meta.id} state={state} meta={meta} ctl={composer} onAfterSend={followBottom} />
        </div>
      </footer>
      {drawerOpen && (
        <FilesDrawer
          sessionId={meta.id}
          onClose={() => setDrawerOpen(false)}
          refreshToken={changesToken}
          initialTab={changesCount > 0 ? "changes" : "files"}
        />
      )}
      {childId && <ChildSessionModal id={childId} workdir={meta.workdir} onClose={() => setChildId(null)} />}
    </main>
  );
}

/** 子代理会话只读回放浮层(D2):复用 useSessionFeed + LogList(readonly),
 * 无 composer、无审批热键;卸载即 session_close(useSessionFeed 清理)。
 * 尾部回放窗口够看完整过程,不做「加载更早」(与旧版 SessionViewer 同口径)。 */
function ChildSessionModal({ id, workdir, onClose }: { id: string; workdir?: string; onClose: () => void }) {
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
          <LogList
            state={state}
            sessionId={id}
            readonly
            uploadUrl={(p) => uploadFileURL(id, p)}
            workdir={workdir}
            loadFullTool={(seq) => sessionFrame(id, seq)}
          />
        </div>
      </div>
      <div className="modal-backdrop cursor-pointer" onClick={onClose} aria-hidden />
    </div>
  );
}
