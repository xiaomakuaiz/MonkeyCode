// 后台会话提醒的判定(D3):session-event → 是否值得打断用户。
// 纯函数与渲染分离——"哪些事件出提示"是产品语义(说错一次就是白等或漏看),
// 单测钉在这里,App 只管画 toast 与跳转。
//
// 规则(与旧工程 sessionNotice.ts 的行为契约对齐,收敛到新事件词汇):
// - 当前正看着的会话不提醒(用户就在现场);
// - session-ask open=true → 等待审批(warning);open=false 是别处已答,不提醒;
// - session-status 转终态 idle/error → 已回复/出错;running 等中间态不提醒;
// - session-summary 是模型异步吐的摘要,与用户的等待无关,不提醒。
import type { SessionEvent } from "@/lib/ipc/sessions";

export type NoticeKind = "ask" | "done" | "error" | "queued";

export interface SessionNotice {
  sessionId: string;
  title: string;
  kind: NoticeKind;
}

/** 后台补投成功的提示(stash::deliverQueued 回调):title = 消息摘录。 */
export function noticeForQueuedDelivery(sessionId: string, text: string): SessionNotice {
  const excerpt = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return { sessionId, title: excerpt, kind: "queued" };
}

export function noticeForSessionEvent(e: SessionEvent, currentId: string | null): SessionNotice | null {
  if (e.id === currentId) return null;
  if (e.type === "session-ask") {
    return e.open ? { sessionId: e.id, title: e.title, kind: "ask" } : null;
  }
  if (e.type !== "session-status") return null;
  if (e.status === "idle") return { sessionId: e.id, title: e.title, kind: "done" };
  if (e.status === "error") return { sessionId: e.id, title: e.title, kind: "error" };
  return null;
}
