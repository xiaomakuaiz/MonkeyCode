// composer 全功能的集成测试:经 ChatView 挂载(真实 useSessionFeed/
// useComposer 链路),假壳 IPC 断言发送面契约(载荷以壳侧 session.rs /
// uploads.rs 为准)。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { ModelInfo, SessionMeta } from "@/lib/ipc/sessions";
import { b64decode, b64encode } from "@/lib/protocol/codec";
import { ChatView } from "../ChatView";

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

const META: SessionMeta = { id: "s1", title: "修复登录", workdir: "/p/a", model: "m", turns: 2, status: "idle" };

interface Op {
  op: string;
  cmd?: string;
  args?: Record<string, unknown>;
}

function stubShell({ models = [] }: { models?: ModelInfo[] } = {}) {
  const ops: Op[] = [];
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        ops.push({ op: "invoke", cmd, args });
        if (cmd === "session_open") {
          return Promise.resolve({
            frames: [{ type: "user-input", data: { content: b64encode("帮我修 bug") }, timestamp: 1, seq: 1 }],
            cursor: 7,
            has_more: false,
          });
        }
        if (cmd === "models_list") return Promise.resolve(models);
        if (cmd === "session_call") return Promise.resolve({ result: {} });
        if (cmd === "upload_begin") return Promise.resolve({ handle: 9 });
        if (cmd === "upload_finish") return Promise.resolve({ path: ".monkeycode/uploads/shot.png" });
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

const COMMANDS_FRAME = {
  type: "task-running",
  kind: "acp_event",
  data: {
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "add-context", description: "补充上下文" },
        { name: "compact", description: "压缩上下文" },
        { name: "review", description: "代码审查", input: { hint: "<范围>" } },
      ],
    },
  },
  timestamp: 2,
  seq: 2,
};

async function ready() {
  await waitFor(() => expect(screen.getByText("帮我修 bug")).toBeTruthy());
  return screen.getByRole("textbox", { name: "消息输入" });
}

const sends = (ops: Op[], ftype: string) =>
  ops.filter((o) => o.cmd === "session_send" && (o.args?.ftype as string) === ftype);
const calls = (ops: Op[], kind: string) =>
  ops.filter((o) => o.cmd === "session_call" && (o.args?.kind as string) === kind);

describe("斜杠指令面板", () => {
  it("敲 / 就地弹出;前缀过滤优先;↑↓ 循环;↩ 填入并保焦点;不发送消息", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    const box = await ready();
    emit("frames:s1", [COMMANDS_FRAME]);

    await userEvent.type(box, "/");
    const panel = await screen.findByRole("listbox", { name: "斜杠指令" });
    expect(panel).toBeTruthy();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("/add-context"),
      expect.stringContaining("/compact"),
      expect.stringContaining("/review"),
    ]);

    await userEvent.type(box, "co");
    // 前缀命中 compact 排前且默认高亮;add-context 子串命中垫底;review 出局
    const opts = screen.getAllByRole("option");
    expect(opts.map((o) => o.textContent)).toEqual([
      expect.stringContaining("/compact"),
      expect.stringContaining("/add-context"),
    ]);
    expect(opts[0]?.getAttribute("aria-selected")).toBe("true");

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{ArrowDown}"); // 底部回绕
    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");

    await userEvent.keyboard("{Enter}");
    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
    expect(screen.queryByRole("listbox")).toBeNull(); // 填入即收起
    expect(document.activeElement).toBe(box); // 焦点还给输入框
    expect(sends(ops, "user-input")).toHaveLength(0); // 这一下 ↩ 不是发送
  });

  it("Esc 关闭(capture,阻断全局链:不误拒待决审批);段落清掉后恢复补全", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    const box = await ready();
    emit("frames:s1", [
      COMMANDS_FRAME,
      { type: "permission-req", data: { id: "p1", title: "npm test", tool: "Bash" }, timestamp: 3, seq: 3 },
    ]);
    await waitFor(() => expect(screen.getByText("需要确认")).toBeTruthy());

    await userEvent.type(box, "/re");
    await screen.findByRole("listbox", { name: "斜杠指令" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "斜杠指令" })).toBeNull();
    // Esc 归面板,没有落到审批快捷键(deny 不可逆)
    expect(sends(ops, "permission-resp")).toHaveLength(0);

    // 同一段 /re 保持压制;清掉后再敲 / 恢复
    await userEvent.type(box, "v");
    expect(screen.queryByRole("listbox", { name: "斜杠指令" })).toBeNull();
    await userEvent.clear(box);
    await userEvent.type(box, "/");
    expect(await screen.findByRole("listbox", { name: "斜杠指令" })).toBeTruthy();
  });
});

describe("模型 / 思考深度 / 权限模式", () => {
  const MODELS: ModelInfo[] = [
    { name: "m", default: true, think: "medium" },
    { name: "gpt-x@baizhi", default: false },
    { name: "vip-model", default: false, locked: true },
  ];

  it("切模型:session_call session_set_model {model:原名};锁定项禁选", async () => {
    const { ops } = stubShell({ models: MODELS });
    render(<ChatView meta={META} />);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "m" }));
    const menu = await screen.findByRole("list", { name: "切换模型" });
    expect(menu).toBeTruthy();
    const locked = screen.getByRole("button", { name: /vip-model/ }) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "gpt-x" }));
    expect(calls(ops, "session_set_model").map((o) => o.args?.payload)).toEqual([{ model: "gpt-x@baizhi" }]);
    expect(screen.queryByRole("list", { name: "切换模型" })).toBeNull();
  });

  it("思考档:触发器显示生效档(会话档 > 模型默认档);选择发 session_set_think", async () => {
    const { ops } = stubShell({ models: MODELS });
    render(<ChatView meta={META} />);
    await ready();
    // 会话未显式选档 → 跟随当前模型 m 配置的 medium
    await userEvent.click(screen.getByRole("button", { name: "思考·中" }));
    await screen.findByRole("list", { name: "思考深度" });
    await userEvent.click(screen.getByRole("button", { name: "高" }));
    expect(calls(ops, "session_set_think").map((o) => o.args?.payload)).toEqual([{ think: "high" }]);
  });

  it("权限 pill:点击与 ⇧⇥ 互切;发送面 = session_set_mode,状态以帧回写为准", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "默认权限" }));
    expect(calls(ops, "session_set_mode").map((o) => o.args?.payload)).toEqual([{ mode: "yolo" }]);

    // 壳回写 permission_mode_update 帧后 pill 翻面;⇧⇥ 从新状态出发切回
    emit("frames:s1", [
      {
        type: "task-running",
        kind: "acp_event",
        data: { update: { sessionUpdate: "permission_mode_update", mode: "yolo" } },
        timestamp: 4,
        seq: 4,
      },
    ]);
    await waitFor(() => expect(screen.getByRole("button", { name: "YOLO" })).toBeTruthy());
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(calls(ops, "session_set_mode").map((o) => o.args?.payload)).toEqual([
      { mode: "yolo" },
      { mode: "default" },
    ]);
  });

  it("运行中:模型/思考触发器禁用(壳会拒绝,本地先不给点)", async () => {
    const { emit } = stubShell({ models: MODELS });
    render(<ChatView meta={META} />);
    await ready();
    emit("frames:s1", [{ type: "task-started", timestamp: 5, seq: 5 }]);
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "m" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "思考·中" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

describe("运行态 / 停止 / 排队", () => {
  it("运行条:思考中 + 停止(user-cancel 帧);工具执行中换文案", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    await ready();
    emit("frames:s1", [{ type: "task-started", timestamp: 5, seq: 5 }]);
    await waitFor(() => expect(screen.getByText("思考中")).toBeTruthy());

    emit("frames:s1", [
      {
        type: "task-running",
        kind: "acp_event",
        data: { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Bash", status: "in_progress" } },
        timestamp: 6,
        seq: 6,
      },
    ]);
    await waitFor(() => expect(screen.getByText("执行中")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    const cancels = sends(ops, "user-cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.args?.payload).toEqual({});
  });

  it("运行中发送进入单槽排队(chip 可取消);轮结束自动补投", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    const box = await ready();
    emit("frames:s1", [{ type: "task-started", timestamp: 5, seq: 5 }]);
    await waitFor(() => expect(screen.getByText("思考中")).toBeTruthy());

    await userEvent.type(box, "补充问题{Enter}");
    expect(screen.getByText("已排队")).toBeTruthy();
    expect(screen.getByText("补充问题")).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("");
    expect(sends(ops, "user-input")).toHaveLength(0); // 运行中不直发

    // 后发覆盖先发(单槽语义)
    await userEvent.type(box, "换个问法{Enter}");
    expect(screen.queryByText("补充问题")).toBeNull();
    expect(screen.getByText("换个问法")).toBeTruthy();

    emit("frames:s1", [{ type: "task-ended", timestamp: 7, seq: 7 }]);
    await waitFor(() => {
      const sent = sends(ops, "user-input");
      expect(sent).toHaveLength(1);
      expect(b64decode((sent[0]?.args?.payload as { content: string }).content)).toBe("换个问法");
    });
    expect(screen.queryByText("已排队")).toBeNull();
  });

  it("排队可取消:清掉后轮结束不补投", async () => {
    const { ops, emit } = stubShell();
    render(<ChatView meta={META} />);
    const box = await ready();
    emit("frames:s1", [{ type: "task-started", timestamp: 5, seq: 5 }]);
    await waitFor(() => expect(screen.getByText("思考中")).toBeTruthy());
    await userEvent.type(box, "先排着{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "取消排队" }));
    expect(screen.queryByText("已排队")).toBeNull();
    emit("frames:s1", [{ type: "task-ended", timestamp: 7, seq: 7 }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(sends(ops, "user-input")).toHaveLength(0);
  });
});

describe("附件与 IME", () => {
  it("粘贴文件:分块上传后 chip 入列;发送按附件行并入正文(壳只解 content)", async () => {
    const { ops } = stubShell();
    render(<ChatView meta={META} />);
    const box = await ready();

    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    fireEvent.paste(box, { clipboardData: { items: [{ kind: "file", getAsFile: () => file }] } });
    await waitFor(() => expect(screen.getByText("shot.png")).toBeTruthy());
    // 分块契约:begin → chunk → finish
    expect(ops.filter((o) => o.cmd === "upload_begin")).toHaveLength(1);
    expect(ops.filter((o) => o.cmd === "upload_chunk")).toHaveLength(1);
    expect(ops.filter((o) => o.cmd === "upload_finish")).toHaveLength(1);

    await userEvent.type(box, "看这张图{Enter}");
    const sent = sends(ops, "user-input");
    expect(sent).toHaveLength(1);
    expect(b64decode((sent[0]?.args?.payload as { content: string }).content)).toBe(
      "看这张图\n[图片] .monkeycode/uploads/shot.png",
    );
    // 发送后附件 chip 清空
    await waitFor(() => expect(screen.queryByText("shot.png")).toBeNull());
  });

  it("移除附件:chip 上的 ✕ 出列,不进正文", async () => {
    stubShell();
    render(<ChatView meta={META} />);
    const box = await ready();
    const file = new File([new Uint8Array([1])], "a.txt", { type: "text/plain" });
    fireEvent.paste(box, { clipboardData: { items: [{ kind: "file", getAsFile: () => file }] } });
    await waitFor(() => expect(screen.getByText("a.txt")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "移除附件" }));
    expect(screen.queryByText("a.txt")).toBeNull();
  });

  it("WKWebView 时序:compositionend 后 100ms 内的 Enter 是选字不发送,过窗后照常", async () => {
    const { ops } = stubShell();
    render(<ChatView meta={META} />);
    const box = await ready();
    await userEvent.type(box, "你好");
    fireEvent.compositionEnd(box);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sends(ops, "user-input")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 120));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(sends(ops, "user-input")).toHaveLength(1));
  });
});

describe("运行条 detail 与上下文用量", () => {
  it("运行中给出「第 N 轮 · tokens」摘要(轮数 = user 项计数)", async () => {
    const { emit } = stubShell();
    render(<ChatView meta={META} />);
    await ready();
    emit("frames:s1", [
      { type: "task-started", timestamp: 5, seq: 5 },
      {
        type: "task-running",
        kind: "acp_event",
        data: { update: { sessionUpdate: "usage_update", used: 45_678, size: 200_000 } },
        timestamp: 6,
        seq: 6,
      },
    ]);
    await waitFor(() => expect(screen.getByText("第 1 轮 · 45.7k tokens")).toBeTruthy());
  });

  it("上下文用量:radial-progress 语义 + tooltip 精确 tokens;>85% 示警", async () => {
    const { emit } = stubShell();
    render(<ChatView meta={META} />);
    await ready();
    emit("frames:s1", [
      {
        type: "task-running",
        kind: "acp_event",
        data: { update: { sessionUpdate: "usage_update", used: 180_000, size: 200_000 } },
        timestamp: 6,
        seq: 6,
      },
    ]);
    const bar = await screen.findByRole("progressbar", { name: "上下文用量" });
    expect(bar.getAttribute("aria-valuenow")).toBe("90");
    expect(bar.closest("[data-tip]")?.getAttribute("data-tip")).toBe("上下文用量 180,000 / 200,000 tokens");
  });
});
