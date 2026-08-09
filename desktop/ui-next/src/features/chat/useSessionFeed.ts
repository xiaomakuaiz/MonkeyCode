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
    if (!id) return;

    let alive = true;
    // 监听句柄按 **Promise** 持有,不按"await 出来的函数":注册本身是异步
    // IPC,cleanup 完全可能早于它落地——此前 cleanup 关掉的是两个还没被赋值
    // 的空占位函数,一次 IPC 往返之内切走会话就把 frames:{id} 监听永久漏在
    // 壳里(每次快速切会话漏一对,旧会话的帧此后一直往已卸载的组件里灌)。
    // 旧 UI session.ts:140-143 同款:退订等 Promise resolve 之后再执行。
    const framesP = onFrames(id, (batch) => {
      if (alive) setState((s) => reduceBatch(s, batch as Frame[]));
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
        // 已有内容时按**前插**处理:回放窗口走命令返回值、实时帧走事件,两条
        // 异步通道谁先到没有保证(壳在 session_open 处理中就同步推首批实时
        // 帧,先到才是常态)。而 reduceBatch 丢弃 seq ≤ 水位的帧(reduce.ts
        // 去重口径),实时 seq 严格高于窗口——只要抢先落一批,整份历史就被
        // 静默丢光,表现为"打开会话只剩最新一两条"。窗口与实时流在壳侧按
        // opened 切分、互不重叠,前插总是正确的(旧 UI useSession.ts:335-338)
        setState((s) =>
          s.items.length === 0 ? reduceBatch(s, win.frames as Frame[]) : prependHistory(s, win.frames as Frame[]),
        );
        // 窗口落地后 running 才可信:composer 的排队补投闸门等这一下
        setHistoryLoaded(true);
      } catch (e) {
        // 壳只在**成功**路径 emit conn-status(driver/session.rs::open),失败
        // 时 conn 恒为 null、连接条根本不渲染——不外显就是一个不解释的空会话
        // (旧 UI session.ts:138「⚠ 打开会话失败: 」)
        if (alive) setOpenError(e instanceof Error ? e.message : String(e));
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
