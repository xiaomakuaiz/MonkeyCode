// 会话数据面 hook:打开/实时帧/翻页/关闭 的生命周期。
// 铁律「监听先于命令」:壳在 session_open 处理中同步 emit 首批实时帧,
// 必须 await onFrames/onConnStatus 注册完成后才 invoke session_open。
// 历史(尾部回放窗口)走返回值、实时走 frames:{id} 事件,归约统一进
// lib/protocol(seq 水位去重在归约层,重放不双写)。
import { useCallback, useEffect, useRef, useState } from "react";

import type { Frame } from "@/lib/protocol/types";
import { afterEngineReady } from "@/lib/ipc/engine";
import { createChatState, prependHistory, reduceBatch } from "@/lib/protocol/reduce";
import type { ChatState } from "@/lib/protocol/types";
import {
  onConnStatus,
  onFrames,
  sessionClose,
  sessionHistory,
  sessionOpen,
  type ConnStatus,
} from "@/lib/ipc/sessions";

const HISTORY_PAGE = 3; // 每次"加载更早"取的轮数窗口(壳侧 cursor 语义)

export interface SessionFeed {
  state: ChatState;
  conn: ConnStatus | null;
  /** 首份历史(session_open 的尾部回放窗口)是否已落地。
   *  落地前 state 只是 createChatState() 的空壳,running 恒 false 却**不可信**
   *  ——会话可能正在后台跑轮。切回时恢复出来的排队消息若在这之前抢投,必被
   *  壳的忙碌守卫拒掉(旧 UI useSession.ts:143「打开后首份历史归约前 running
   *  未知:恢复的排队消息不能抢投」)。 */
  historyLoaded: boolean;
  /** session_open 失败的原因(null = 未失败)。壳只在**成功**路径 emit
   *  conn-status(driver/session.rs::open),失败这条线上没有任何信号回流:
   *  不在这里外显就是一个不作任何解释的空会话。 */
  openError: string | null;
  hasMore: boolean;
  loadingEarlier: boolean;
  /** loadEarlier 最近一次失败的原因(成功即清空);null = 无故障。 */
  earlierError: string | null;
  /** 往更早翻一页(前插;滚动补偿由视图侧做)。
   *  beforeApply 在写入 state **前**同步回调,供视图记录滚动锚点——视图不能
   *  自己"先记锚点再 await":消费锚点的 layoutEffect 依赖 items,流式期间
   *  每批帧都会触发它,锚点会被前插之前的某次提交吃掉(旧 UI
   *  useSession.ts:349 的 beforeApply 就是为此存在)。 */
  loadEarlier: (beforeApply?: () => void) => Promise<void>;
  /** 确保 offset(replay.jsonl 字节偏移,与大纲 OutlineItem.offset 同坐标系)
   *  所在的那一轮已加载——大纲跳到窗口之前的提问时按偏移精确补页。 */
  ensureLoaded: (offset: number) => Promise<void>;
}

/** epoch:引擎重启自愈信号(D1)。App 在引擎 Ready 且此前掉过时自增,
 *  effect 依赖它整体重跑 = 幂等重开(壳对未登记 sid 懒登记并回放历史)。 */
export function useSessionFeed(id: string | null, epoch = 0): SessionFeed {
  const [state, setState] = useState<ChatState>(createChatState);
  const [conn, setConn] = useState<ConnStatus | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const cursorRef = useRef(0);
  // 镜像 ref:ensureLoaded 的循环在一次异步流程里连续翻页,不能等 state 回流
  const hasMoreRef = useRef(false);
  const busyRef = useRef(false);
  // 当前活跃会话:翻页请求跨会话切换返回时丢弃,防止旧会话的页混进新状态
  const liveIdRef = useRef<string | null>(null);
  /** 回放窗口落地**之前**到达的实时帧缓冲(非 null = 还在等窗口)。
   *
   *  为什么必须攒着而不是先落地:回放窗口走 session_open 的返回值、实时帧走
   *  frames:{id} 事件,两条异步通道谁先到没有保证——壳在 session_open 处理中
   *  就同步推首批实时帧(driver/session.rs 在锁内置 opened=true 后帧才进 batch,
   *  transport.rs 的 30ms flusher 随时可能抢在整份窗口序列化 + 过 IPC 之前
   *  emit),**先到才是常态**。而 reduceBatch 按 seq 水位去重、实时 seq 严格
   *  高于窗口:只要实时帧先落一批把水位抬起来,窗口帧就会被逐帧丢弃。
   *
   *  此前的判据是 `s.items.length === 0 ? reduceBatch : prependHistory`——
   *  **判据用 items、水位用 lastSeq,两个口径**。一批实时帧完全可以抬高水位
   *  却一个 ChatItem 都不产(task-started / usage_update / plan /
   *  available_commands_update,以及最常见的 tool_call_update:按 tcId 找卡,
   *  而 tool_call 帧正躺在还没落地的窗口里,找不到就原样返回;跑子代理时父
   *  会话正是被 tool_call_progress 连续刷屏)。此时 items 仍为 0 → 走
   *  reduceBatch → 窗口帧全部 seq ≤ 水位被丢光,表现为"打开一个正在跑的会话
   *  只剩空态插画",连带 task-started 也没了 → running 停在 false → 空态把
   *  「加载更早」按钮一起换掉,本次打开里没有任何自救入口。
   *
   *  攒帧比"把判据改成 lastSeq === 0"更彻底:后者在竞态分支下走 prependHistory,
   *  而它只取 items(见 reduce.ts 头注:过去的帧不该回写现状),窗口携带的
   *  running/usage/model/think/permMode/commands 会被一起丢掉。按到达顺序
   *  「窗口在前、缓冲在后」一次归约,状态与条目都是对的。 */
  const pendingRef = useRef<Frame[] | null>(null);

  useEffect(() => {
    setState(createChatState());
    setConn(null);
    setHistoryLoaded(false);
    setOpenError(null);
    setHasMore(false);
    setEarlierError(null);
    cursorRef.current = 0;
    hasMoreRef.current = false;
    liveIdRef.current = id;
    pendingRef.current = []; // 本轮重新开始攒:窗口未落地前的实时帧一律入缓冲
    if (!id) return;

    let alive = true;
    // 监听句柄按 **Promise** 持有,不按"await 出来的函数":注册本身是异步
    // IPC,cleanup 完全可能早于它落地——此前 cleanup 关掉的是两个还没被赋值
    // 的空占位函数,一次 IPC 往返之内切走会话就把 frames:{id} 监听永久漏在
    // 壳里(每次快速切会话漏一对,旧会话的帧此后一直往已卸载的组件里灌)。
    // 旧 UI session.ts:140-143 同款:退订等 Promise resolve 之后再执行。
    const framesP = onFrames(id, (batch) => {
      if (!alive) return;
      // 窗口还没落地就先攒着(见 pendingRef 头注),别把水位抬到窗口之上
      const pending = pendingRef.current;
      if (pending) {
        pending.push(...(batch as Frame[]));
        return;
      }
      setState((s) => reduceBatch(s, batch as Frame[]));
    });
    const connP = onConnStatus(id, (s) => {
      if (alive) setConn(s);
    });
    void (async () => {
      try {
        await Promise.all([framesP, connP]);
        if (!alive) return;
        // 退避重试:引擎重启后 Ready 与壳的 apply 闸门有重叠窗口,首发必被拒
        // (afterEngineReady 头注记了壳侧契约)。不重试的话浏览器配对后这次
        // 重开就静默失败,对话继续挂在旧引擎上、拿不到新 MCP 工具集
        const win = await afterEngineReady(() => sessionOpen(id));
        if (!alive) return;
        cursorRef.current = win.cursor;
        hasMoreRef.current = !!win.has_more;
        setHasMore(hasMoreRef.current);
        // 窗口在前、等待期间攒下的实时帧在后,一次归约按真实先后落地。
        // 窗口与实时流在壳侧按 opened 切分、互不重叠,seq 严格递增,
        // reduceBatch 的批内去重顺带兜住壳偶发重推
        const buffered = pendingRef.current ?? [];
        pendingRef.current = null; // 出缓冲态:此后实时帧直落
        setState((s) => reduceBatch(s, [...(win.frames as Frame[]), ...buffered]));
        // 窗口落地后 running 才可信:composer 的排队补投闸门等这一下
        setHistoryLoaded(true);
      } catch (e) {
        // 壳只在**成功**路径 emit conn-status(driver/session.rs::open),失败
        // 时 conn 恒为 null、连接条根本不渲染——不外显就是一个不解释的空会话
        // (旧 UI session.ts:138「⚠ 打开会话失败: 」)
        if (!alive) return;
        // 打开失败也必须出缓冲态并把攒下的帧放行,否则实时帧会一直堆在缓冲里
        // 永不渲染——壳侧会话其实可能还在跑,界面却是个一动不动的空屏
        const buffered = pendingRef.current;
        pendingRef.current = null;
        if (buffered?.length) setState((s) => reduceBatch(s, buffered));
        setOpenError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      void framesP.then((f) => f()).catch(() => {});
      void connP.then((f) => f()).catch(() => {});
      void sessionClose(id);
    };
  }, [id, epoch]);

  const loadEarlier = useCallback(async (beforeApply?: () => void) => {
    if (!id || busyRef.current) return;
    busyRef.current = true;
    setLoadingEarlier(true);
    try {
      // ⚠️ session_history 返回 next_cursor(与 session_open 的 cursor 不同名)
      const page = await sessionHistory(id, cursorRef.current, HISTORY_PAGE);
      if (liveIdRef.current !== id) return;
      cursorRef.current = page.next_cursor ?? 0;
      hasMoreRef.current = !!page.has_more;
      setHasMore(hasMoreRef.current);
      // 锚点回调必须**紧贴写入之前**同步发生:视图消费锚点的 layoutEffect 依赖
      // items,而流式期间每 ~30ms 就有一批新帧——视图若"先记锚点再 await",
      // 锚点会被前插之前的某次提交吃掉,随后按错的元素把视口硬拽几秒
      beforeApply?.();
      setState((s) => prependHistory(s, page.frames as Frame[]));
      setEarlierError(null);
    } catch (e) {
      if (liveIdRef.current === id) setEarlierError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setLoadingEarlier(false);
    }
  }, [id]);

  // 上限兜底防坏 cursor 死循环;没前进(失败/到头)即止,别空转(旧 UI 同款)
  const ensureLoaded = useCallback(
    async (offset: number) => {
      for (let i = 0; i < 200 && hasMoreRef.current && cursorRef.current > offset; i++) {
        const before = cursorRef.current;
        await loadEarlier();
        if (cursorRef.current === before) return;
      }
    },
    [loadEarlier],
  );

  return { state, conn, historyLoaded, openError, hasMore, loadingEarlier, earlierError, loadEarlier, ensureLoaded };
}
