import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { PermItem, ToolItem } from "@/lib/protocol/types";
import { ToolCard } from "./ToolCard";

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

/** 最小壳桩:engine_caps 全开、session_send 应答成功(乐观态成立)。 */
function stubShell() {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string) =>
        cmd === "engine_caps"
          ? Promise.resolve({ browser_ext: false, usage_update: true, perm_remember: true, attachments: true })
          : Promise.resolve(undefined),
    },
  };
}

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

  it("内嵌审批:暂停图标顶掉状态点 + 卡底按钮行", () => {
    const perm: PermItem = { kind: "perm", id: "p1", title: "npm test", tool: "Bash", state: "open", toolCallId: "t1" };
    const { container } = render(<ToolCard item={{ ...BASE, status: "run" }} perm={perm} sessionId="s1" />);
    expect(container.querySelector("svg.text-warning")).toBeTruthy(); // 暂停图标
    expect(container.querySelector(".status")).toBeNull(); // 状态点被顶掉
    expect(screen.getByText("需要确认")).toBeTruthy();
    expect(screen.getByRole("button", { name: "允许" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
  });

  it("内嵌审批乐观态按 perm.id 键控:同卡二次锚定新审批,按钮行重现(H8)", async () => {
    stubShell();
    const perm = (id: string): PermItem => ({ kind: "perm", id, title: "npm test", tool: "Bash", state: "open", toolCallId: "t1" });
    const { rerender } = render(<ToolCard item={{ ...BASE, status: "run" }} perm={perm("p1")} sessionId="s1" />);
    await userEvent.click(screen.getByRole("button", { name: "允许" }));
    expect(screen.queryByRole("button", { name: "允许" })).toBeNull();
    expect(screen.getByText("已允许")).toBeTruthy();

    // 同一张工具卡(同一渲染位)锚定第二张审批:乐观态必须随 id 重置
    rerender(<ToolCard item={{ ...BASE, status: "run" }} perm={perm("p2")} sessionId="s1" />);
    expect(screen.getByRole("button", { name: "允许" })).toBeTruthy();
    expect(screen.queryByText("已允许")).toBeNull();
  });

  it("childSessionId + onOpenChild:头部出「查看子会话」入口并回传 id", async () => {
    const opened: string[] = [];
    render(<ToolCard item={{ ...BASE, childSessionId: "c1" }} sessionId="s1" onOpenChild={(id) => opened.push(id)} />);
    await userEvent.click(screen.getByRole("button", { name: "查看子会话" }));
    expect(opened).toEqual(["c1"]);
  });

  it("缺 onOpenChild(如云端只读流)时不渲染子会话入口", () => {
    render(<ToolCard item={{ ...BASE, childSessionId: "c1" }} sessionId="s1" />);
    expect(screen.queryByRole("button", { name: "查看子会话" })).toBeNull();
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

describe("工具产出图片", () => {
  it("有 uploadUrl:images 过滤图片路径渲染缩略图,点击开大图浮层", async () => {
    const item = { kind: "tool", tcId: "t9", title: "浏览器截图", status: "ok", out: "", images: [".monkeycode/uploads/shot.png", "notes.txt"] } as ToolItem;
    render(<ToolCard item={item} sessionId="s1" uploadUrl={() => Promise.resolve("data:image/png;base64,AAA")} />);
    const img = await screen.findByRole("img", { name: ".monkeycode/uploads/shot.png" });
    expect(screen.queryByRole("img", { name: "notes.txt" })).toBeNull();
    await userEvent.click(img);
    expect(await screen.findByRole("dialog", { name: ".monkeycode/uploads/shot.png" })).toBeTruthy();
  });

  it("无 uploadUrl:不渲染图片区", () => {
    const item = { kind: "tool", tcId: "t9", title: "浏览器截图", status: "ok", out: "", images: [".monkeycode/uploads/shot.png"] } as ToolItem;
    render(<ToolCard item={item} sessionId="s1" />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
