import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { FrameSender } from "@/lib/ipc/approvals";
import { createChatState } from "@/lib/protocol/reduce";
import type { ChatItem, ChatState } from "@/lib/protocol/types";
import { LogList } from "./LogList";

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

function withItems(items: ChatItem[]): ChatState {
  return { ...createChatState(), items };
}

const TOOL: Extract<ChatItem, { kind: "tool" }> = { kind: "tool", tcId: "t1", title: "Bash npm test", status: "run", out: "" };

describe("LogList 锚定分发", () => {
  it("perm 带 toolCallId 且有同 id 工具卡:按钮行嵌进工具卡,独立审批卡不渲染", () => {
    const state = withItems([
      TOOL,
      { kind: "perm", id: "p1", title: "npm test", tool: "Bash", state: "open", toolCallId: "t1" },
    ]);
    const { container } = render(<LogList state={state} sessionId="s1" />);
    // 按钮行只出现一次(在工具卡里),独立警示卡不存在
    expect(screen.getAllByRole("button", { name: "允许" })).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    // 结构契约:直接子元素仍与 items 一一对应(被锚定项是占位 div)
    expect(container.firstElementChild?.children).toHaveLength(2);
  });

  it("无锚(缺 toolCallId / 找不到同 id 工具卡)渲染独立审批卡", () => {
    const state = withItems([
      { kind: "perm", id: "p1", title: "rm -rf x", tool: "Bash", state: "open" },
      { kind: "perm", id: "p2", title: "curl", tool: "Bash", state: "open", toolCallId: "不存在的卡" },
    ]);
    render(<LogList state={state} sessionId="s1" />);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "允许" })).toHaveLength(2);
  });

  it("已决的锚定 perm 不再独立渲染(工具卡状态代言),工具卡也无按钮行", () => {
    const state = withItems([
      { ...TOOL, status: "ok" },
      { kind: "perm", id: "p1", title: "npm test", tool: "Bash", state: "approved", toolCallId: "t1" },
    ]);
    render(<LogList state={state} sessionId="s1" />);
    expect(screen.queryByRole("button", { name: "允许" })).toBeNull();
    expect(screen.queryByText("已允许")).toBeNull();
  });

  it("提问卡与工具卡正常分发", () => {
    const state = withItems([
      TOOL,
      {
        kind: "ask",
        askId: "q1",
        state: "open",
        questions: [{ question: "选哪个?", multiSelect: false, custom: false, options: [{ label: "A" }] }],
      },
    ]);
    render(<LogList state={state} sessionId="s1" />);
    expect(screen.getByText("Bash npm test")).toBeTruthy();
    expect(screen.getByText("需要你的回答")).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交回答" })).toBeTruthy();
  });
});

describe("LogList 上行管道注入(sendFrame)", () => {
  it("审批(工具卡锚定)与提问答复都走注入的 sendFrame,不触本地 IPC", async () => {
    const sent: { ftype: string; payload: Record<string, unknown> }[] = [];
    const sendFrame: FrameSender = (ftype, payload) => {
      sent.push({ ftype, payload });
      return Promise.resolve();
    };
    const state = withItems([
      TOOL,
      { kind: "perm", id: "p1", title: "npm test", tool: "Bash", state: "open", toolCallId: "t1" },
      {
        kind: "ask",
        askId: "q1",
        state: "open",
        questions: [{ question: "选哪个?", multiSelect: false, custom: false, options: [{ label: "A" }] }],
      },
    ]);
    render(<LogList state={state} sessionId="cloud-task-1" sendFrame={sendFrame} />);

    await userEvent.click(screen.getByRole("button", { name: "允许" }));
    await userEvent.click(screen.getByRole("radio", { name: "A" }));
    await userEvent.click(screen.getByRole("button", { name: "提交回答" }));

    expect(sent).toEqual([
      { ftype: "permission-resp", payload: { id: "p1", approved: true, remember: false, persist: false } },
      {
        ftype: "reply-question",
        payload: { request_id: "q1", answers_json: JSON.stringify({ "选哪个?": "A" }), cancelled: false },
      },
    ]);
    // 乐观置态成立 = 走的确是注入 sender:本地 IPC 在非壳环境必 reject 回滚
    expect(screen.getByText("已允许")).toBeTruthy();
    expect(screen.getByText("已回答")).toBeTruthy();
  });
});
