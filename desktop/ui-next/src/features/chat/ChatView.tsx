// 聊天视图:header(标题+连接态)+ 消息流(贴底跟随/加载更早保位)+ 简版
// composer(P3d 换全功能:斜杠面板/附件/模型选择/排队)。
// 滚动策略:贴底时新内容自动跟随,用户上滚即解除;"加载更早"前插后按
// scrollHeight 差值补偿 scrollTop,视口纹丝不动。
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { useI18n } from "@/lib/i18n";
import type { SessionMeta } from "@/lib/ipc/sessions";
import { sessionSend } from "@/lib/ipc/sessions";
import { b64encode } from "@/lib/protocol/codec";
import { LogList } from "./LogList";
import { useSessionFeed } from "./useSessionFeed";

const PIN_THRESHOLD = 40; // 距底多少像素内算"贴底"

export function ChatView({ meta }: { meta: SessionMeta }) {
  const { t } = useI18n();
  const { state, conn, hasMore, loadingEarlier, loadEarlier } = useSessionFeed(meta.id);
  const [draft, setDraft] = useState("");
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

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    pinnedRef.current = true;
    void sessionSend(meta.id, "user-input", { content: b64encode(text) }).catch(() => {
      setDraft(text); // 未送达不丢内容
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组合期的 Enter 是选字,不是发送(P3d 补 WKWebView 时序守卫)
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-base-100">
      <header data-view-header="" className="flex h-11 shrink-0 items-center gap-2 border-b border-base-300 px-4">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{meta.title}</h1>
        {conn && !conn.connected && (
          <span className="badge badge-warning badge-soft badge-sm">{conn.text}</span>
        )}
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
          <LogList state={state} />
        </div>
      </div>

      <footer className="shrink-0 border-t border-base-300 p-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            aria-label={t("chat.composer")}
            className="textarea min-h-10 w-full resize-none text-sm"
            rows={2}
            placeholder={t("chat.composerPlaceholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="btn btn-primary btn-sm" disabled={!draft.trim()} onClick={send}>
            {t("chat.send")}
          </button>
        </div>
      </footer>
    </main>
  );
}
