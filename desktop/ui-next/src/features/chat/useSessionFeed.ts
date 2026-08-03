// 会话数据面 hook:打开/实时帧/翻页/关闭 的生命周期。
// 铁律「监听先于命令」:壳在 session_open 处理中同步 emit 首批实时帧,
// 必须 await onFrames/onConnStatus 注册完成后才 invoke session_open。
// 历史(尾部回放窗口)走返回值、实时走 frames:{id} 事件,归约统一进
// lib/protocol(seq 水位去重在归约层,重放不双写)。
import { useCallback, useEffect, useRef, useState } from "react";

import type { Frame } from "@/lib/protocol/types";
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
  /** 往更早翻一页(前插;滚动补偿由视图侧按 scrollHeight 差值做)。 */
  loadEarlier: () => Promise<void>;
}

/** epoch:引擎重启自愈信号(D1)。App 在引擎 Ready 且此前掉过时自增,
 *  effect 依赖它整体重跑 = 幂等重开(壳对未登记 sid 懒登记并回放历史)。 */
export function useSessionFeed(id: string | null, epoch = 0): SessionFeed {
  const [state, setState] = useState<ChatState>(createChatState);
  const [conn, setConn] = useState<ConnStatus | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const cursorRef = useRef(0);

  useEffect(() => {
    setState(createChatState());
    setConn(null);
    setHasMore(false);
    cursorRef.current = 0;
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
        const win = await sessionOpen(id);
        if (!alive) return;
        cursorRef.current = win.cursor;
        setHasMore(win.has_more);
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
    if (!id || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const win = await sessionHistory(id, cursorRef.current, HISTORY_PAGE);
      cursorRef.current = win.cursor;
      setHasMore(win.has_more);
      setState((s) => prependHistory(s, win.frames as Frame[]));
    } catch {
      // 失败保持现状,按钮可重试
    } finally {
      setLoadingEarlier(false);
    }
  }, [id, loadingEarlier]);

  return { state, conn, hasMore, loadingEarlier, loadEarlier };
}
