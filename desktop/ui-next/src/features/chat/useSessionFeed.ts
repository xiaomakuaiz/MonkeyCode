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
  hasMore: boolean;
  loadingEarlier: boolean;
  /** loadEarlier 最近一次失败的原因(成功即清空);null = 无故障。 */
  earlierError: string | null;
  /** 往更早翻一页(前插;滚动补偿由视图侧做)。 */
  loadEarlier: () => Promise<void>;
  /** 确保 offset(replay.jsonl 字节偏移,与大纲 OutlineItem.offset 同坐标系)
   *  所在的那一轮已加载——大纲跳到窗口之前的提问时按偏移精确补页。 */
  ensureLoaded: (offset: number) => Promise<void>;
}

/** epoch:引擎重启自愈信号(D1)。App 在引擎 Ready 且此前掉过时自增,
 *  effect 依赖它整体重跑 = 幂等重开(壳对未登记 sid 懒登记并回放历史)。 */
export function useSessionFeed(id: string | null, epoch = 0): SessionFeed {
  const [state, setState] = useState<ChatState>(createChatState);
  const [conn, setConn] = useState<ConnStatus | null>(null);
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
    setHasMore(false);
    setEarlierError(null);
    cursorRef.current = 0;
    hasMoreRef.current = false;
    liveIdRef.current = id;
    if (!id) return;

    let alive = true;
    let offFrames = () => {};
    let offConn = () => {};
    void (async () => {
      offFrames = await onFrames(id, (batch) => {
        if (alive) setState((s) => reduceBatch(s, batch as Frame[]));
      });
      offConn = await onConnStatus(id, (s) => {
        if (alive) setConn(s);
      });
      if (!alive) return;
      try {
        // 退避重试:引擎重启后 Ready 与壳的 apply 闸门有重叠窗口,首发必被拒
        // (afterEngineReady 头注记了壳侧契约)。不重试的话浏览器配对后这次
        // 重开就静默失败,对话继续挂在旧引擎上、拿不到新 MCP 工具集
        const win = await afterEngineReady(() => sessionOpen(id));
        if (!alive) return;
        cursorRef.current = win.cursor;
        hasMoreRef.current = !!win.has_more;
        setHasMore(hasMoreRef.current);
        setState((s) => reduceBatch(s, win.frames as Frame[]));
      } catch {
        // 打开失败:conn-status 通道会带出错文案;浏览器模式静默空会话
      }
    })();
    return () => {
      alive = false;
      offFrames();
      offConn();
      void sessionClose(id);
    };
  }, [id, epoch]);

  const loadEarlier = useCallback(async () => {
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

  return { state, conn, hasMore, loadingEarlier, earlierError, loadEarlier, ensureLoaded };
}
