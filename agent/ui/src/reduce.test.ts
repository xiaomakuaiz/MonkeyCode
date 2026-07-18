// reduce.ts 归约器单测:帧 → 对话流渲染项的全部状态转移。
// 纯函数无 DOM,直接在 node 环境跑(vitest 默认);帧构造经 codec 编码,
// 与内核下行格式(data = base64(JSON))一致。
import { describe, expect, it } from "vitest";
import { b64encode } from "./codec";
import { answerPerm, initialChat, permStateLabel, reduceBatch, reduceFrame } from "./reduce";
import type { AcpUpdate, Frame, LogItem, ToolProgress } from "./types";

const frame = (type: string, data?: unknown, kind?: string): Frame => ({
  type,
  ...(kind ? { kind } : {}),
  ...(data !== undefined ? { data: b64encode(JSON.stringify(data)) } : {}),
});

const acp = (update: Partial<AcpUpdate>): Frame =>
  frame("task-running", { update }, "acp_event");

const run = (frames: Frame[]) => reduceBatch(initialChat, frames);

const toolItem = (s: ReturnType<typeof run>, tcId: string) =>
  s.items.find((it) => it.kind === "tool" && it.tcId === tcId) as Extract<LogItem, { kind: "tool" }>;

describe("流式文本聚合", () => {
  it("连续 agent 块合并为一项", () => {
    const s = run([
      acp({ sessionUpdate: "agent_message_chunk", content: { text: "你好" } }),
      acp({ sessionUpdate: "agent_message_chunk", content: { text: ",世界" } }),
    ]);
    expect(s.items).toEqual([{ kind: "agent", text: "你好,世界" }]);
  });

  it("thought 与 agent 互不合并", () => {
    const s = run([
      acp({ sessionUpdate: "agent_thought_chunk", content: { text: "想" } }),
      acp({ sessionUpdate: "agent_message_chunk", content: { text: "说" } }),
      acp({ sessionUpdate: "agent_thought_chunk", content: { text: "再想" } }),
    ]);
    expect(s.items.map((it) => it.kind)).toEqual(["thought", "agent", "thought"]);
  });

  it("被非流式项打断后新开一项,不并入旧项", () => {
    const s = run([
      acp({ sessionUpdate: "agent_message_chunk", content: { text: "前" } }),
      acp({ sessionUpdate: "tool_call", toolCallId: "t1", title: "读取 a.txt" }),
      acp({ sessionUpdate: "agent_message_chunk", content: { text: "后" } }),
    ]);
    expect(s.items.map((it) => it.kind)).toEqual(["agent", "tool", "agent"]);
    expect((s.items[2] as Extract<LogItem, { kind: "agent" }>).text).toBe("后");
  });
});

describe("工具调用生命周期", () => {
  it("tool_call 创建运行中卡片,标题缺省回退", () => {
    const s = run([acp({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "read" })]);
    expect(toolItem(s, "t1")).toMatchObject({ title: "read", status: "run", out: "" });
  });

  it("completed 置 ok,rawOutput 取首行且截断 160 字符", () => {
    const long = "x".repeat(200) + "\n第二行";
    const s = run([
      acp({ sessionUpdate: "tool_call", toolCallId: "t1", title: "执行 ls" }),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: long }),
    ]);
    expect(toolItem(s, "t1").status).toBe("ok");
    expect(toolItem(s, "t1").out).toBe("x".repeat(160));
  });

  it("非 completed 终态置 fail;结束时清掉 lastLine", () => {
    const progress: ToolProgress = { kind: "output", line: "运行中输出…" };
    const s = run([
      acp({ sessionUpdate: "tool_call", toolCallId: "t1", title: "执行 job" }),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", progress }),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", rawOutput: "boom" }),
    ]);
    expect(toolItem(s, "t1")).toMatchObject({ status: "fail", out: "boom", lastLine: undefined });
  });

  it("更新只落在匹配 tcId 的卡片上", () => {
    const s = run([
      acp({ sessionUpdate: "tool_call", toolCallId: "t1", title: "A" }),
      acp({ sessionUpdate: "tool_call", toolCallId: "t2", title: "B" }),
      acp({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
    ]);
    expect(toolItem(s, "t1").status).toBe("ok");
    expect(toolItem(s, "t2").status).toBe("run");
  });
});

describe("执行期进度(in_progress progress)", () => {
  const open = acp({ sessionUpdate: "tool_call", toolCallId: "t1", title: "task 子代理" });
  const prog = (progress: ToolProgress): Frame =>
    acp({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", progress });

  it("subagent_tool 按 id 追加与原地更新,标题缺省保留旧值", () => {
    const s = run([
      open,
      prog({ kind: "subagent_tool", id: "s1", title: "读取 a.txt", status: "run" }),
      prog({ kind: "subagent_tool", id: "s1", status: "ok" }),
    ]);
    expect(toolItem(s, "t1").feed).toEqual([{ kind: "tool", id: "s1", title: "读取 a.txt", status: "ok" }]);
  });

  it("subagent_text 追加文本行,空行忽略", () => {
    const s = run([
      open,
      prog({ kind: "subagent_text", line: "第一行" }),
      prog({ kind: "subagent_text" }),
    ]);
    expect(toolItem(s, "t1").feed).toEqual([{ kind: "text", text: "第一行" }]);
  });

  it("进度窗口封顶 200 条,旧条目滚出", () => {
    const frames: Frame[] = [open];
    for (let i = 0; i < 205; i++) frames.push(prog({ kind: "subagent_text", line: "line" + i }));
    const feed = toolItem(run(frames), "t1").feed!;
    expect(feed).toHaveLength(200);
    expect(feed[0]).toEqual({ kind: "text", text: "line5" });
    expect(feed[199]).toEqual({ kind: "text", text: "line204" });
  });

  it("output 覆写 lastLine;child_session 记录子会话 ID", () => {
    const s = run([
      open,
      prog({ kind: "output", line: "旧行" }),
      prog({ kind: "output", line: "新行" }),
      prog({ kind: "child_session", childSessionId: "c1" }),
    ]);
    expect(toolItem(s, "t1")).toMatchObject({ lastLine: "新行", childSessionId: "c1" });
  });

  it("找不到对应工具卡时不改状态", () => {
    const s0 = run([open]);
    const s1 = reduceFrame(s0, prog({ kind: "output", line: "x" }));
    const miss = reduceFrame(s1, acp({ sessionUpdate: "tool_call_update", toolCallId: "无此ID", status: "in_progress", progress: { kind: "output", line: "y" } }));
    expect(miss).toBe(s1);
  });
});

describe("计划卡片", () => {
  it("连续 plan 帧合并进末尾卡片", () => {
    const s = run([
      acp({ sessionUpdate: "plan", entries: [{ content: "步骤一", status: "pending" }] }),
      acp({ sessionUpdate: "plan", entries: [{ content: "步骤一", status: "completed" }] }),
    ]);
    const plans = s.items.filter((it) => it.kind === "plan");
    expect(plans).toEqual([{ kind: "plan", entries: [{ content: "步骤一", status: "completed" }] }]);
  });

  it("中间隔了其他内容后,plan 在当前位置新建卡片,旧卡片保留原快照", () => {
    const s = run([
      acp({ sessionUpdate: "plan", entries: [{ content: "步骤一", status: "pending" }] }),
      acp({ sessionUpdate: "agent_message_chunk", content: { text: "开始干活" } }),
      acp({ sessionUpdate: "plan", entries: [{ content: "步骤一", status: "completed" }] }),
    ]);
    expect(s.items.map((it) => it.kind)).toEqual(["plan", "agent", "plan"]);
    expect(s.items[0]).toEqual({ kind: "plan", entries: [{ content: "步骤一", status: "pending" }] });
    expect(s.items[2]).toEqual({ kind: "plan", entries: [{ content: "步骤一", status: "completed" }] });
  });
});

describe("审批卡片状态机", () => {
  const req = frame("permission-req", { id: "p1", title: "rm -rf /tmp/x", tool: "bash" });

  it("permission-req 建开放卡片;缺 id 忽略", () => {
    const s = run([req, frame("permission-req", { title: "无 id" })]);
    expect(s.items).toEqual([{ kind: "perm", id: "p1", title: "rm -rf /tmp/x", tool: "bash", state: "open" }]);
  });

  it("permission-resolved 只落在开放卡片上", () => {
    const s = run([req, frame("permission-resolved", { id: "p1", outcome: "approved" })]);
    expect(s.items[0]).toMatchObject({ state: "approved" });
    // 已终态的卡片不被再次改写
    const s2 = reduceFrame(s, frame("permission-resolved", { id: "p1", outcome: "denied" }));
    expect(s2.items[0]).toMatchObject({ state: "approved" });
  });

  it("answerPerm 本地立即回写,仅作用于开放卡片", () => {
    const s = run([req]);
    expect(answerPerm(s, "p1", true).items[0]).toMatchObject({ state: "allowed" });
    expect(answerPerm(s, "p1", false).items[0]).toMatchObject({ state: "rejected" });
    const resolved = run([req, frame("permission-resolved", { id: "p1", outcome: "denied" })]);
    expect(answerPerm(resolved, "p1", true).items[0]).toMatchObject({ state: "denied" });
  });

  it("轮次结束/出错时开放卡片过期", () => {
    expect(run([req, frame("task-ended")]).items[0]).toMatchObject({ state: "expired" });
    expect(run([req, frame("task-error", { error: "x" })]).items[0]).toMatchObject({ state: "expired" });
  });

  it("终态文案映射", () => {
    expect(permStateLabel("allowed")).toBe("已允许");
    expect(permStateLabel("timeout")).toBe("已超时(按拒绝处理)");
    expect(permStateLabel("未知态")).toBe("未知态");
  });
});

describe("轮次与系统帧", () => {
  it("task-started 置运行中;task-ended 复位并标记 turnEnded + 分隔线", () => {
    const started = run([frame("task-started")]);
    expect(started.running).toBe(true);
    const ended = reduceFrame(started, frame("task-ended"));
    expect(ended).toMatchObject({ running: false, turnEnded: true, streamKind: "" });
    expect(ended.items.at(-1)).toEqual({ kind: "sys", text: "— 本轮结束 —" });
  });

  it("task-error 渲染错误系统行,缺 error 字段回退文案", () => {
    const s = run([frame("task-error", { error: "配额耗尽" })]);
    expect(s.items.at(-1)).toEqual({ kind: "sys", text: "✗ 配额耗尽", error: true });
    expect(run([frame("task-error")]).items.at(-1)).toEqual({ kind: "sys", text: "✗ 未知错误", error: true });
  });

  it("user-input 解 base64(含多字节);坏编码回退原文", () => {
    const s = run([frame("user-input", { content: b64encode("修复 Bug🐛") })]);
    expect(s.items[0]).toEqual({ kind: "user", text: "修复 Bug🐛" });
    const bad = run([frame("user-input", { content: "!!!不是base64" })]);
    expect(bad.items[0]).toEqual({ kind: "user", text: "!!!不是base64" });
  });

  it("usage/model/permMode 回写状态并留系统行", () => {
    const s = run([
      acp({ sessionUpdate: "usage_update", used: 1200, size: 200000 }),
      acp({ sessionUpdate: "model_update", model: "gpt-x" }),
      acp({ sessionUpdate: "permission_mode_update", mode: "yolo" }),
    ]);
    expect(s.usage).toEqual({ used: 1200, size: 200000 });
    expect(s.model).toBe("gpt-x");
    expect(s.permMode).toBe("yolo");
    expect(s.items.filter((it) => it.kind === "sys")).toHaveLength(2);
  });

  it("compact_status 与 llm_call_retry 渲染系统行", () => {
    const s = run([
      acp({ sessionUpdate: "compact_status", status: "started" }),
      acp({ sessionUpdate: "llm_call_retry", attempt: 2, message: "429" }),
    ]);
    expect(s.items.map((it) => (it as Extract<LogItem, { kind: "sys" }>).text)).toEqual([
      "⟳ 上下文接近上限,正在压缩…",
      "模型调用重试 #2: 429",
    ]);
  });

  it("未知帧/未知 sessionUpdate/非 acp kind 一律原样返回", () => {
    const s = run([acp({ sessionUpdate: "agent_message_chunk", content: { text: "a" } })]);
    expect(reduceFrame(s, frame("不认识"))).toBe(s);
    expect(reduceFrame(s, acp({ sessionUpdate: "future_update" }))).toBe(s);
    expect(reduceFrame(s, { type: "task-running", kind: "别的" })).toBe(s);
  });
});
