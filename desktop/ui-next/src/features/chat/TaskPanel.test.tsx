import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { PlanEntry } from "@/lib/protocol/types";
import { TaskPanel } from "./TaskPanel";

const PLAN: PlanEntry[] = [
  { content: "读代码", status: "completed" },
  { content: "改代码", status: "in_progress" },
  { content: "跑测试", status: "pending" },
];

describe("任务面板", () => {
  it("收起态:一行摘要 = 进度 + 正在项", () => {
    render(<TaskPanel entries={PLAN} />);
    expect(screen.getByText("任务 1/3")).toBeTruthy();
    expect(screen.getByText(/正在:改代码/)).toBeTruthy();
    expect(screen.getByRole("button", { expanded: false })).toBeTruthy();
  });

  it("无进行中项时摘要给「接下来」的 pending 项", () => {
    render(<TaskPanel entries={[{ content: "读代码", status: "completed" }, { content: "写文档", status: "pending" }]} />);
    expect(screen.getByText(/接下来:写文档/)).toBeTruthy();
  });

  it("展开:限高清单,checkbox 只读态映射 completed;摘要行收起", async () => {
    render(<TaskPanel entries={PLAN} />);
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false]);
    expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(["读代码", "改代码", "跑测试"]);
    // 展开后摘要行不再重复"正在"
    expect(screen.queryByText(/正在:改代码/)).toBeNull();
    expect(screen.getByText("改代码")).toBeTruthy();
  });
});
