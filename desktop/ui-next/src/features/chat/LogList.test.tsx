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

const TOOL: Extract<ChatItem, { kind: "tool" }> = { kind: "tool", tcId: "t1", title: "Bash npm test", status: "run", out: "", rawInput: { command: "npm test" } };

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
    // 工具卡标题经 presentToolCall 拆成「动作 + 目标」
    expect(screen.getByText("执行命令")).toBeTruthy();
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText("需要你的回答")).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交回答" })).toBeTruthy();
  });
});

describe("LogList 系统行居中(H7)", () => {
  it("包裹 div 是 flex 列,sys 条目 self-center 有生效上下文", () => {
    const state = withItems([{ kind: "sys", text: "— 本轮结束 —" }]);
    render(<LogList state={state} sessionId="s1" />);
    const sys = screen.getByText("— 本轮结束 —");
    expect(sys.className).toContain("self-center");
    // 直接包裹层必须是 flex 列(块级包裹层会让 align-self 失效,居中丢失)
    expect(sys.parentElement?.className).toContain("flex");
    expect(sys.parentElement?.className).toContain("flex-col");
  });
});

describe("LogList 系统行按 tag 分流", () => {
  it("turn-end 收敛为呼吸位:不渲染文字,全文留在 title", () => {
    const state = withItems([{ kind: "sys", text: "— 本轮结束 —", tag: "turn-end" }]);
    render(<LogList state={state} sessionId="s1" />);
    expect(screen.queryByText("— 本轮结束 —")).toBeNull();
    expect(screen.getByTitle("— 本轮结束 —")).toBeTruthy();
  });

  it("连续模型切换只渲最后一条;被合并行保占位,结构契约不平移", () => {
    const state = withItems([
      { kind: "sys", text: "模型已切换为 A", tag: "model" },
      { kind: "sys", text: "模型已切换为 B", tag: "model" },
      { kind: "sys", text: "模型已切换为 C", tag: "model" },
    ]);
    const { container } = render(<LogList state={state} sessionId="s1" />);
    expect(screen.queryByText("模型已切换为 A")).toBeNull();
    expect(screen.queryByText("模型已切换为 B")).toBeNull();
    expect(screen.getByText("模型已切换为 C")).toBeTruthy();
    // 直接子元素仍与 items 一一对应(被合并项是占位 div)
    expect(container.firstElementChild?.children).toHaveLength(3);
  });

  it("模型行被其他条目隔断即各自成段,不跨条目合并", () => {
    const state = withItems([
      { kind: "sys", text: "模型已切换为 A", tag: "model" },
      { kind: "agent", text: "中间正文" },
      { kind: "sys", text: "模型已切换为 B", tag: "model" },
    ]);
    render(<LogList state={state} sessionId="s1" />);
    expect(screen.getByText("模型已切换为 A")).toBeTruthy();
    expect(screen.getByText("模型已切换为 B")).toBeTruthy();
  });

  it("error 系统行按 text-error 着色,普通系统行不带", () => {
    const state = withItems([
      { kind: "sys", text: "✗ 配额耗尽", error: true },
      { kind: "sys", text: "📌 后台完成", tag: "notify" },
    ]);
    render(<LogList state={state} sessionId="s1" />);
    expect(screen.getByText("✗ 配额耗尽").className).toContain("text-error");
    expect(screen.getByText("📌 后台完成").className).not.toContain("text-error");
  });
});

describe("消息时间(悬停显影的 <time>)", () => {
  it("用户气泡与 agent 块渲染 dateTime 语义的 HH:MM;缺 timestamp 不渲染", () => {
    const ts = new Date(2026, 0, 2, 9, 5).getTime();
    const state = withItems([
      { kind: "user", text: "带时间的提问", seq: 1, timestamp: ts },
      { kind: "agent", text: "带时间的回答", timestamp: ts },
      { kind: "agent", text: "没有时间" },
    ]);
    const { container } = render(<LogList state={state} sessionId="s1" />);
    const times = Array.from(container.querySelectorAll("time"));
    expect(times).toHaveLength(2);
    for (const t of times) {
      expect(t.getAttribute("datetime")).toBe(new Date(ts).toISOString());
      expect(t.textContent).toBe("09:05");
    }
  });
});

describe("思考块(thoughtMarkdown 修复)", () => {
  it("流式连拼的相邻加粗标题拆开渲染,不吞成一个 strong", () => {
    const state = withItems([{ kind: "thought", text: "**先看日志****再改代码**" }]);
    render(<LogList state={state} sessionId="s1" />);
    // 修复生效 = 两个独立的加粗段(吞并时会渲成含 ** 字面量的单个 strong)
    expect(screen.getAllByText("先看日志").some((el) => el.tagName === "STRONG")).toBe(true);
    expect(screen.getAllByText("再改代码").some((el) => el.tagName === "STRONG")).toBe(true);
  });
});

describe("LogList 只读回放(readonly,子会话浮层)", () => {
  it("独立 open 审批收成审计行:无按钮,标「需要确认」", () => {
    const state = withItems([
      { kind: "perm", id: "p1", title: "rm -rf x", tool: "Bash", state: "open" },
    ]);
    render(<LogList state={state} sessionId="c1" readonly />);
    expect(screen.queryByRole("button", { name: "允许" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("需要确认")).toBeTruthy();
  });

  it("锚定 open 审批不产生内嵌按钮行,工具卡按常态渲染", () => {
    const state = withItems([
      TOOL,
      { kind: "perm", id: "p1", title: "npm test", tool: "Bash", state: "open", toolCallId: "t1" },
    ]);
    const { container } = render(<LogList state={state} sessionId="c1" readonly />);
    expect(screen.queryByRole("button", { name: "允许" })).toBeNull();
    expect(screen.queryByText("需要确认")).toBeNull();
    // 结构契约不平移:被锚定项仍是占位 div
    expect(container.firstElementChild?.children).toHaveLength(2);
  });

  it("open 提问卡按只读摘要渲染,不出作答表单", () => {
    const state = withItems([
      {
        kind: "ask",
        askId: "q1",
        state: "open",
        questions: [{ question: "选哪个?", multiSelect: false, custom: false, options: [{ label: "A" }] }],
      },
    ]);
    render(<LogList state={state} sessionId="c1" readonly />);
    expect(screen.queryByRole("button", { name: "提交回答" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByText("选哪个?")).toBeTruthy();
    expect(screen.getAllByText("未回答").length).toBeGreaterThan(0);
  });
});

describe("LogList 子会话入口(onOpenChildSession)", () => {
  it("工具卡带 childSessionId 且传了回调:入口可点并回传 id", async () => {
    const opened: string[] = [];
    const state = withItems([{ ...TOOL, childSessionId: "c1" }]);
    render(<LogList state={state} sessionId="s1" onOpenChildSession={(id) => opened.push(id)} />);
    await userEvent.click(screen.getByRole("button", { name: "查看子会话" }));
    expect(opened).toEqual(["c1"]);
  });

  it("缺 childSessionId 或缺回调:不渲染入口", () => {
    const { rerender } = render(
      <LogList state={withItems([TOOL])} sessionId="s1" onOpenChildSession={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "查看子会话" })).toBeNull();
    rerender(<LogList state={withItems([{ ...TOOL, childSessionId: "c1" }])} sessionId="s1" />);
    expect(screen.queryByRole("button", { name: "查看子会话" })).toBeNull();
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

describe("用户气泡附件呈现(附件行约定)", () => {
  const TEXT = "看看这个\n[图片] .monkeycode/uploads/a.png\n[文件] .monkeycode/uploads/b.txt";

  it("有 uploadUrl:附件行剥离,图片缩略图 + 文件 chip;点图开大图浮层", async () => {
    const uploadUrl = (p: string) => Promise.resolve(`data:image/png;base64,${p.length}`);
    const state = withItems([{ kind: "user", text: TEXT, seq: 1 }]);
    render(<LogList state={state} sessionId="s1" uploadUrl={uploadUrl} />);

    expect(screen.getByText("看看这个")).toBeTruthy();
    // 附件行不再出现在气泡正文
    expect(screen.queryByText(/\[图片\]/)).toBeNull();
    expect(screen.queryByText(/\[文件\]/)).toBeNull();
    // 图片按路径为 alt 异步渲染;文件 chip 以文件名成钮
    const img = await screen.findByRole("img", { name: ".monkeycode/uploads/a.png" });
    expect(img.getAttribute("src")).toMatch(/^data:image\/png/);
    expect(screen.getByRole("button", { name: "b.txt" })).toBeTruthy();

    await userEvent.click(img);
    expect(await screen.findByRole("dialog", { name: ".monkeycode/uploads/a.png" })).toBeTruthy();
  });

  it("无 uploadUrl(云端/无通道):正文原样,不剥附件行", () => {
    const state = withItems([{ kind: "user", text: TEXT, seq: 1 }]);
    render(<LogList state={state} sessionId="s1" />);
    expect(screen.getByText(/\[图片\] \.monkeycode\/uploads\/a\.png/)).toBeTruthy();
  });

  it("云端 attachments:图片直链渲染,文件 chip 走浏览器打开语义", () => {
    const state = withItems([
      {
        kind: "user",
        text: "带附件",
        seq: 2,
        attachments: [
          { url: "https://oss/x.png", filename: "x.png" },
          { url: "https://oss/y.pdf", filename: "y.pdf" },
        ],
      },
    ]);
    render(<LogList state={state} sessionId="cloud-1" />);
    const img = screen.getByRole("img", { name: "x.png" });
    expect(img.getAttribute("src")).toBe("https://oss/x.png");
    expect(screen.getByRole("button", { name: "y.pdf" })).toBeTruthy();
  });
});

describe("思考块", () => {
  it("带首片时间(hover 显影 <time>);展开指示与工具卡同语言(无 collapse-arrow)", () => {
    const ts = new Date(2026, 7, 5, 9, 5).getTime();
    const state = withItems([{ kind: "thought", text: "先看日志", timestamp: ts }]);
    const { container } = render(<LogList state={state} sessionId="s1" />);
    expect(container.querySelector("time")?.textContent).toBe("09:05");
    expect(container.querySelector(".collapse-arrow")).toBeNull(); // 统一为行尾 chevron
  });
});

describe("长工具组折叠", () => {
  const tools = (n: number): ChatItem[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: "tool" as const,
      tcId: `t${i + 1}`,
      title: "Bash",
      status: "ok" as const,
      out: "",
      rawInput: { command: `step${i + 1}` },
    }));

  it("≥6 张连续工具卡:默认显首 1 尾 3,中段收进「展开其余 N 步」", async () => {
    const state = withItems(tools(7));
    const { container } = render(<LogList state={state} sessionId="s1" />);
    // 结构契约:包裹层仍与 items 一一对应
    expect(container.firstElementChild?.children).toHaveLength(7);
    expect(screen.getByText("step1")).toBeTruthy(); // 首
    expect(screen.getByText("step5")).toBeTruthy(); // 尾 3
    expect(screen.getByText("step7")).toBeTruthy();
    expect(screen.queryByText("step2")).toBeNull(); // 中段折叠
    expect(screen.queryByText("step4")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /展开其余 3 步/ }));
    expect(screen.getByText("step2")).toBeTruthy();
    expect(screen.getByText("step4")).toBeTruthy();
    expect(container.firstElementChild?.children).toHaveLength(7);
  });

  it("5 张以内不折叠", () => {
    render(<LogList state={withItems(tools(5))} sessionId="s1" />);
    expect(screen.queryByRole("button", { name: /展开其余/ })).toBeNull();
    expect(screen.getByText("step3")).toBeTruthy();
  });
});
