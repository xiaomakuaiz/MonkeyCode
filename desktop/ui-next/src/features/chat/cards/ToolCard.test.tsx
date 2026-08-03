import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { PermItem, ToolItem } from "@/lib/protocol/types";
import { ToolCard } from "./ToolCard";

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

const BASE: ToolItem = { kind: "tool", tcId: "t1", title: "Bash npm test", status: "ok", out: "" };

describe("工具卡", () => {
  it("标题 + 耗时(只显示可靠的最终耗时)", () => {
    render(<ToolCard item={{ ...BASE, durationMs: 1234 }} sessionId="s1" />);
    expect(screen.getByText("Bash npm test")).toBeTruthy();
    expect(screen.getByText("1.2s")).toBeTruthy();
  });

  it("失败:外显 out 首行(role=alert)", () => {
    render(<ToolCard item={{ ...BASE, status: "fail", out: "exit 1: 找不到模块" }} sessionId="s1" />);
    expect(screen.getByRole("alert").textContent).toContain("exit 1: 找不到模块");
  });

  it("详情 collapse:入参 JSON 与结果文本(经 toolResultText)", () => {
    render(
      <ToolCard
        item={{
          ...BASE,
          rawInput: { command: "npm test" },
          rawOutput: { stdout: "42 passed", stderr: "" },
        }}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("详情")).toBeTruthy();
    expect(screen.getByText(/"command": "npm test"/)).toBeTruthy();
    expect(screen.getByText("42 passed")).toBeTruthy();
  });

  it("运行中不出详情入口(终态才可回看入参/结果)", () => {
    render(<ToolCard item={{ ...BASE, status: "run", rawInput: { command: "x" } }} sessionId="s1" />);
    expect(screen.queryByText("详情")).toBeNull();
  });

  it("feed 窗口:运行中只显尾部 5 条,完成后收起", () => {
    const feed: ToolItem["feed"] = [
      { kind: "tool", id: "a", title: "第 1 步", status: "ok" },
      { kind: "tool", id: "b", title: "第 2 步", status: "ok" },
      { kind: "text", text: "第 3 步说明" },
      { kind: "tool", id: "d", title: "第 4 步", status: "ok" },
      { kind: "tool", id: "e", title: "第 5 步", status: "ok" },
      { kind: "tool", id: "f", title: "第 6 步", status: "run" },
    ];
    const { rerender } = render(<ToolCard item={{ ...BASE, status: "run", feed }} sessionId="s1" />);
    expect(screen.queryByText("第 1 步")).toBeNull(); // 滚出窗口
    expect(screen.getByText("第 2 步")).toBeTruthy();
    expect(screen.getByText("第 3 步说明")).toBeTruthy();
    expect(screen.getByText("第 6 步")).toBeTruthy();

    rerender(<ToolCard item={{ ...BASE, status: "ok", feed }} sessionId="s1" />);
    expect(screen.queryByText("第 6 步")).toBeNull();
  });

  it("运行中的最新输出行(lastLine)外显", () => {
    render(<ToolCard item={{ ...BASE, status: "run", lastLine: "Compiling crate…" }} sessionId="s1" />);
    expect(screen.getByText("Compiling crate…")).toBeTruthy();
  });

  it("内嵌审批:⏸ 顶掉状态点 + 卡底按钮行", () => {
    const perm: PermItem = { kind: "perm", id: "p1", title: "npm test", tool: "Bash", state: "open", toolCallId: "t1" };
    render(<ToolCard item={{ ...BASE, status: "run" }} perm={perm} sessionId="s1" />);
    expect(screen.getByText("⏸")).toBeTruthy();
    expect(screen.getByText("需要确认")).toBeTruthy();
    expect(screen.getByRole("button", { name: "允许" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
  });

  it("report_findings:渲染结构化发现列表", () => {
    render(
      <ToolCard
        item={{
          ...BASE,
          title: "ReportFindings: 1 项发现",
          rawInput: {
            findings: [{ file: "src/auth.ts", line: 42, summary: "token 未过期校验", verdict: "CONFIRMED" }],
          },
        }}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("token 未过期校验")).toBeTruthy();
    expect(screen.getByText("已证实")).toBeTruthy();
    expect(screen.getByText("auth.ts:42")).toBeTruthy();
  });
});
