import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/lib/ipc/sessions";
import { noticeForSessionEvent } from "./notices";

const ev = (over: Partial<SessionEvent>): SessionEvent => ({
  type: "session-status",
  id: "s2",
  title: "后台任务",
  ...over,
});

describe("后台会话提醒判定(D3)", () => {
  it("当前会话的事件一律不提醒(用户就在现场)", () => {
    expect(noticeForSessionEvent(ev({ type: "session-ask", open: true }), "s2")).toBeNull();
    expect(noticeForSessionEvent(ev({ status: "idle" }), "s2")).toBeNull();
  });

  it("session-ask:open 置真提醒 warning;置假(别处已答)不提醒", () => {
    expect(noticeForSessionEvent(ev({ type: "session-ask", open: true }), "s1")).toEqual({
      sessionId: "s2",
      title: "后台任务",
      kind: "ask",
    });
    expect(noticeForSessionEvent(ev({ type: "session-ask", open: false }), "s1")).toBeNull();
  });

  it("session-status:idle→done、error→error;中间态不提醒", () => {
    expect(noticeForSessionEvent(ev({ status: "idle" }), "s1")?.kind).toBe("done");
    expect(noticeForSessionEvent(ev({ status: "error" }), "s1")?.kind).toBe("error");
    expect(noticeForSessionEvent(ev({ status: "running" }), "s1")).toBeNull();
  });

  it("session-summary 与用户等待无关,不提醒", () => {
    expect(noticeForSessionEvent(ev({ type: "session-summary", summary: "x" }), "s1")).toBeNull();
  });

  it("未选中任何会话(currentId=null)时,任何会话的事件都算后台", () => {
    expect(noticeForSessionEvent(ev({ status: "error" }), null)?.kind).toBe("error");
  });
});
