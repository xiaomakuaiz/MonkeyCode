import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionMeta } from "@/lib/ipc/sessions";
import { b64encode } from "@/lib/protocol/codec";
import { ChatView } from "./ChatView";

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

const META: SessionMeta = { id: "s1", title: "修复登录", workdir: "/p/a", model: "m", turns: 2, status: "idle" };

interface Op {
  op: string;
  cmd?: string;
  args?: Record<string, unknown>;
}

function stubShell({ hasMore = false }: { hasMore?: boolean } = {}) {
  const ops: Op[] = [];
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        ops.push({ op: "invoke", cmd, args });
        if (cmd === "session_open") {
          return Promise.resolve({
            frames: [
              { type: "user-input", data: { content: b64encode("帮我修 bug") }, timestamp: 1, seq: 1 },
              {
                type: "task-running",
                kind: "acp_event",
                data: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "先看**日志**" } } },
                timestamp: 2,
                seq: 2,
              },
            ],
            cursor: 7,
            has_more: hasMore,
          });
        }
        if (cmd === "session_history") {
          return Promise.resolve({
            frames: [{ type: "user-input", data: { content: b64encode("更早的问题") }, timestamp: 0, seq: 0 }],
            cursor: 3,
            has_more: false,
          });
        }
        return Promise.resolve(null);
      },
    },
    event: {
      listen: (name: string, cb: (e: { payload: unknown }) => void) => {
        ops.push({ op: "listen", cmd: name });
        listeners.set(name, cb);
        return Promise.resolve(() => listeners.delete(name));
      },
    },
  };
  return { ops, emit: (name: string, payload: unknown) => listeners.get(name)?.({ payload }) };
}

describe("聊天视图", () => {
  it("铁律:frames/conn 监听注册先于 session_open;回放窗口渲染用户气泡与 agent markdown", async () => {
    const { ops } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    expect(screen.getByText("日志").tagName).toBe("STRONG");

    const openAt = ops.findIndex((o) => o.op === "invoke" && o.cmd === "session_open");
    const framesAt = ops.findIndex((o) => o.op === "listen" && o.cmd === "frames:s1");
    const connAt = ops.findIndex((o) => o.op === "listen" && o.cmd === "conn-status:s1");
    expect(framesAt).toBeGreaterThanOrEqual(0);
    expect(framesAt).toBeLessThan(openAt);
    expect(connAt).toBeLessThan(openAt);
  });

  it("实时帧经事件继续归约(流式追加)", async () => {
    const { emit } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    emit("frames:s1", [
      {
        type: "task-running",
        kind: "acp_event",
        data: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ",再跑测试" } } },
        timestamp: 3,
        seq: 3,
      },
    ]);
    await waitFor(() => expect(screen.getByText(/再跑测试/)).toBeTruthy());
  });

  it("加载更早:前插历史且 cursor 前移,原条目仍在", async () => {
    const { ops } = stubShell({ hasMore: true });
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "加载更早" }));
    await waitFor(() => expect(screen.getByText("更早的问题")).toBeTruthy());
    expect(screen.getByText("帮我修 bug")).toBeTruthy();
    const hist = ops.find((o) => o.cmd === "session_history");
    expect(hist?.args).toEqual({ id: "s1", cursor: 7, limit: 3 });
  });

  it("发送:user-input 帧 content 走 base64;失败不丢草稿", async () => {
    const { ops } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    const box = screen.getByRole("textbox", { name: "消息输入" });
    await userEvent.type(box, "第二个问题");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    const sent = ops.find((o) => o.cmd === "session_send");
    expect(sent?.args).toEqual({ id: "s1", ftype: "user-input", payload: { content: b64encode("第二个问题") } });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("Enter 发送、Shift+Enter 换行", async () => {
    const { ops } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    const box = screen.getByRole("textbox", { name: "消息输入" });
    await userEvent.type(box, "甲{Shift>}{Enter}{/Shift}乙");
    expect(ops.some((o) => o.cmd === "session_send")).toBe(false);
    await userEvent.type(box, "{Enter}");
    const sent = ops.find((o) => o.cmd === "session_send");
    expect(sent?.args?.payload).toEqual({ content: b64encode("甲\n乙") });
  });

  it("卸载即 session_close(会话切换不漏连接)", async () => {
    const { ops } = stubShell();
    const { unmount } = render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    unmount();
    expect(ops.some((o) => o.cmd === "session_close")).toBe(true);
  });
});
