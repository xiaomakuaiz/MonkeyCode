// 云端任务列表:运行中置顶、历史折叠段、选择回调(假壳 invoke)。
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudTask } from "@/lib/ipc/cloudtasks";
import { CloudTaskList } from "./CloudTaskList";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function stubShell(invoke: Invoke) {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
}

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

const tasks: CloudTask[] = [
  { id: "a", title: "修复登录", status: "processing" },
  { id: "b", summary: "旧任务甲", status: "finished" },
  { id: "c", content: "旧任务乙", status: "error" },
];

describe("CloudTaskList", () => {
  it("运行中置顶展示,历史收进「云端历史」折叠段;点击回调", async () => {
    stubShell((cmd) => {
      if (cmd === "mc_tasks") return Promise.resolve({ tasks, page_info: { total: 3 } });
      return Promise.resolve({});
    });
    const onSelect = vi.fn();
    render(<CloudTaskList currentId={null} onSelect={onSelect} />);
    await screen.findByText("修复登录");
    expect(screen.getByText("云端历史")).toBeTruthy();
    expect(screen.getByText("旧任务甲")).toBeTruthy(); // title 缺省回退 summary
    expect(screen.getByText("旧任务乙")).toBeTruthy(); // 再回退 content
    await userEvent.click(screen.getByText("旧任务甲"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("空列表:空态文案", async () => {
    stubShell((cmd) =>
      cmd === "mc_tasks" ? Promise.resolve({ tasks: [], page_info: { total: 0 } }) : Promise.resolve({}),
    );
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    await screen.findByText("还没有云端任务");
  });

  it("首屏失败:错误 + 重试按钮可重拉", async () => {
    let calls = 0;
    stubShell((cmd) => {
      if (cmd !== "mc_tasks") return Promise.resolve({});
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("会话失效"))
        : Promise.resolve({ tasks, page_info: { total: 3 } });
    });
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("会话失效");
    await userEvent.click(screen.getByText("重试"));
    await screen.findByText("修复登录");
  });

  it("总数超已载:历史段出「加载更多」并续拉合并", async () => {
    const page2: CloudTask[] = [{ id: "d", title: "更早的", status: "finished" }];
    stubShell((cmd, args) => {
      if (cmd !== "mc_tasks") return Promise.resolve({});
      return Promise.resolve(
        (args?.page as number) === 1 ? { tasks, page_info: { total: 4 } } : { tasks: page2, page_info: { total: 4 } },
      );
    });
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    await screen.findByText("修复登录");
    await userEvent.click(screen.getByText("加载更多"));
    await screen.findByText("更早的");
    await waitFor(() => expect(screen.queryByText("加载更多")).toBeNull()); // 4/4 载完
  });
});
