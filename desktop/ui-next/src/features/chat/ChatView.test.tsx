import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function stubShell({ hasMore = false, outline }: { hasMore?: boolean; outline?: unknown[] } = {}) {
  const ops: Op[] = [];
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        ops.push({ op: "invoke", cmd, args });
        if (cmd === "session_outline") return Promise.resolve(outline ?? null);
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

  it("全局键盘审批:待决审批时 ⏎ 允许(permission-resp 载荷对表壳侧)", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    emit("frames:s1", [
      { type: "permission-req", data: { id: "p1", title: "npm test", tool: "Bash" }, timestamp: 4, seq: 4 },
    ]);
    await waitFor(() => expect(screen.getByText("需要确认")).toBeTruthy());
    await userEvent.keyboard("{Enter}");
    const sent = ops.find((o) => o.cmd === "session_send" && (o.args?.ftype as string) === "permission-resp");
    expect(sent?.args?.payload).toEqual({ id: "p1", approved: true, remember: false, persist: false });
  });

  it("全局键盘审批:esc 拒绝;无待决审批时 ⏎/esc 不发任何帧", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    await userEvent.keyboard("{Enter}{Escape}");
    expect(ops.some((o) => o.cmd === "session_send")).toBe(false);

    emit("frames:s1", [
      { type: "permission-req", data: { id: "p2", title: "curl", tool: "Bash" }, timestamp: 4, seq: 4 },
    ]);
    await waitFor(() => expect(screen.getByText("需要确认")).toBeTruthy());
    await userEvent.keyboard("{Escape}");
    const sent = ops.find((o) => o.cmd === "session_send" && (o.args?.ftype as string) === "permission-resp");
    expect(sent?.args?.payload).toEqual({ id: "p2", approved: false, remember: false, persist: false });
  });

  it("键盘审批不抢正在写的消息:composer 有草稿时 ⏎ 走发送,不是允许", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    emit("frames:s1", [
      { type: "permission-req", data: { id: "p3", title: "npm test", tool: "Bash" }, timestamp: 4, seq: 4 },
    ]);
    await waitFor(() => expect(screen.getByText("需要确认")).toBeTruthy());
    const box = screen.getByRole("textbox", { name: "消息输入" });
    await userEvent.type(box, "先等等{Enter}");
    expect(ops.some((o) => o.cmd === "session_send" && (o.args?.ftype as string) === "permission-resp")).toBe(false);
    expect(ops.some((o) => o.cmd === "session_send" && (o.args?.ftype as string) === "user-input")).toBe(true);
  });

  it("卸载即 session_close(会话切换不漏连接)", async () => {
    const { ops } = stubShell();
    const { unmount } = render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    unmount();
    expect(ops.some((o) => o.cmd === "session_close")).toBe(true);
  });

  it("头部摘要:meta.summary 作为副标题显示;无摘要不渲染", async () => {
    stubShell();
    const { unmount } = render(<ChatView meta={{ ...META, summary: "正在修复登录页闪退" }} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    expect(screen.getByText("正在修复登录页闪退")).toBeTruthy();
    unmount();
    stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    expect(screen.queryByText("正在修复登录页闪退")).toBeNull();
  });

  it("任务面板:plan 帧非空时钉在 composer 上方,收起态一行摘要", async () => {
    const { emit } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    expect(screen.queryByText(/任务 \d/)).toBeNull();
    emit("frames:s1", [
      {
        type: "task-running",
        kind: "acp_event",
        data: {
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "读代码", status: "completed" },
              { content: "改代码", status: "in_progress" },
            ],
          },
        },
        timestamp: 5,
        seq: 5,
      },
    ]);
    await waitFor(() => expect(screen.getByText("任务 1/2")).toBeTruthy());
    expect(screen.getByText(/正在:改代码/)).toBeTruthy();
  });

  it("H1 浮层优先:抽屉开 + 待审批,一次 Esc 只关抽屉不发 permission-resp;再按才拒绝", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "会话文件" }));
    expect(screen.getByRole("region", { name: "会话文件" })).toBeTruthy();
    emit("frames:s1", [
      { type: "permission-req", data: { id: "p9", title: "npm test", tool: "Bash" }, timestamp: 4, seq: 4 },
    ]);
    await waitFor(() => expect(screen.getByText("需要确认")).toBeTruthy());

    const permResp = () => ops.filter((o) => o.cmd === "session_send" && (o.args?.ftype as string) === "permission-resp");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "会话文件" })).toBeNull(); // 抽屉关了
    expect(permResp()).toHaveLength(0); // 同一下按键没顺手拒绝(deny 不可逆)

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(permResp()).toHaveLength(1));
    expect(permResp()[0]?.args?.payload).toEqual({ id: "p9", approved: false, remember: false, persist: false });
  });

  it("D4 双击标题改名:Enter 提交 session_patch,不乐观改 meta(等 session-event 回写)", async () => {
    const { ops } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    fireEvent.doubleClick(screen.getByText("修复登录"));
    const input = screen.getByRole("textbox", { name: "会话标题" }) as HTMLInputElement;
    expect(input.value).toBe("修复登录");
    fireEvent.change(input, { target: { value: "登录闪退修复" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const patches = ops.filter((o) => o.cmd === "session_patch");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.args).toEqual({ id: "s1", patch: { title: "登录闪退修复" } });
    // 输入态退出;标题不乐观改(列表 patch 经 session-event 回写才换)
    expect(screen.queryByRole("textbox", { name: "会话标题" })).toBeNull();
    expect(screen.getByText("修复登录")).toBeTruthy();
  });

  it("D4 改名守卫:Esc 放弃;空/未变不提交;失焦提交;IME 选字回车不提交", async () => {
    const { ops } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    const patches = () => ops.filter((o) => o.cmd === "session_patch");
    const open = () => {
      fireEvent.doubleClick(screen.getByText("修复登录"));
      return screen.getByRole("textbox", { name: "会话标题" }) as HTMLInputElement;
    };

    // Esc 放弃:不发 patch
    let input = open();
    fireEvent.change(input, { target: { value: "不要这个名字" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(patches()).toHaveLength(0);
    expect(screen.queryByRole("textbox", { name: "会话标题" })).toBeNull();

    // 未变/空白:Enter 收编辑态但不发 patch
    input = open();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(patches()).toHaveLength(0);
    input = open();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(patches()).toHaveLength(0);

    // IME 选字回车(compositionend 时间窗内)不提交
    input = open();
    fireEvent.change(input, { target: { value: "拼音标题" } });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(patches()).toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "会话标题" })).toBeTruthy(); // 仍在编辑态

    // 失焦提交(上面的编辑态直接失焦)
    fireEvent.blur(screen.getByRole("textbox", { name: "会话标题" }));
    expect(patches()).toHaveLength(1);
    expect(patches()[0]?.args).toEqual({ id: "s1", patch: { title: "拼音标题" } });
  });

  it("D2 子会话回放:入口打开只读浮层(先监听后 open),关闭即 session_close", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    emit("frames:s1", [
      {
        type: "task-running",
        kind: "acp_event",
        data: { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Agent 子任务", status: "in_progress" } },
        timestamp: 4,
        seq: 4,
      },
      {
        type: "task-running",
        kind: "acp_event",
        data: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            status: "in_progress",
            progress: { kind: "child_session", childSessionId: "c1" },
          },
        },
        timestamp: 5,
        seq: 5,
      },
    ]);
    await userEvent.click(await screen.findByRole("button", { name: "查看子会话" }));

    // 浮层出现,子会话遵守铁律:frames:c1 监听先于 session_open(id=c1)
    expect(await screen.findByRole("dialog", { name: "子代理会话" })).toBeTruthy();
    const childOpenAt = ops.findIndex((o) => o.op === "invoke" && o.cmd === "session_open" && o.args?.id === "c1");
    const childFramesAt = ops.findIndex((o) => o.op === "listen" && o.cmd === "frames:c1");
    expect(childOpenAt).toBeGreaterThanOrEqual(0);
    expect(childFramesAt).toBeGreaterThanOrEqual(0);
    expect(childFramesAt).toBeLessThan(childOpenAt);
    // 只读回放:无第二个 composer(浮层里没有消息输入)
    expect(screen.getAllByRole("textbox", { name: "消息输入" })).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "子代理会话" })).toBeNull();
    expect(ops.some((o) => o.cmd === "session_close" && o.args?.id === "c1")).toBe(true);
  });

  it("D2 浮层 Esc:浮层优先关闭,不落到审批热键(不发 permission-resp)", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    emit("frames:s1", [
      {
        type: "task-running",
        kind: "acp_event",
        data: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "Agent 子任务",
            status: "in_progress",
            progress: { kind: "child_session", childSessionId: "c1" },
          },
        },
        timestamp: 4,
        seq: 4,
      },
      { type: "permission-req", data: { id: "p8", title: "npm test", tool: "Bash" }, timestamp: 5, seq: 5 },
    ]);
    await userEvent.click(await screen.findByRole("button", { name: "查看子会话" }));
    await screen.findByRole("dialog", { name: "子代理会话" });

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "子代理会话" })).toBeNull();
    expect(ops.some((o) => o.cmd === "session_send" && (o.args?.ftype as string) === "permission-resp")).toBe(false);
  });

  it("提问大纲:目标锚不在当前窗口时循环 loadEarlier 补页直到出现", async () => {
    const { ops } = stubShell({
      hasMore: true,
      outline: [
        { seq: 0, offset: 0, content: b64encode("更早的问题"), timestamp: 0 },
        { seq: 1, offset: 10, content: b64encode("帮我修 bug"), timestamp: 1 },
      ],
    });
    render(<ChatView meta={META} />);
    await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
    const nav = await screen.findByRole("navigation", { name: "提问大纲" });
    fireEvent.mouseEnter(nav.firstElementChild!);
    // 目录条目在,正文里还没有(在更早的历史页里)
    expect(screen.getByText("更早的问题")).toBeTruthy();
    expect(ops.some((o) => o.cmd === "session_history")).toBe(false);
    fireEvent.click(screen.getByText("更早的问题"));
    // 补页循环:effect 驱动,每页提交后重查锚,直到气泡渲染出来
    await waitFor(() => expect(screen.getByText("更早的问题")).toBeTruthy());
    expect(ops.some((o) => o.cmd === "session_history")).toBe(true);
  });
});
