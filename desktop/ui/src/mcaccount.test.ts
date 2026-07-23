import { describe, expect, it, vi } from "vitest";
import { inspectMcAccount } from "./mcaccount";

describe("inspectMcAccount", () => {
  it("未关联时只读取状态,不拉任务也不隐式登录", async () => {
    const tasks = vi.fn();
    const result = await inspectMcAccount(
      async () => ({ logged_in: false, host: "monkeycode-ai.com" }),
      tasks,
    );
    expect(result.tasks).toEqual([]);
    expect(tasks).not.toHaveBeenCalled();
  });

  it("已关联时拉取任务列表", async () => {
    const tasks = vi.fn(async () => ({ tasks: [{ id: "task-1", status: "processing" as const }] }));
    const result = await inspectMcAccount(
      async () => ({ logged_in: true, host: "monkeycode-ai.com", user: { name: "tester" } }),
      tasks,
    );
    expect(tasks).toHaveBeenCalledOnce();
    expect(result.tasks).toEqual([{ id: "task-1", status: "processing" }]);
  });

  it("任务刷新失败不抹掉已关联账号状态", async () => {
    const result = await inspectMcAccount(
      async () => ({ logged_in: true, host: "monkeycode-ai.com" }),
      async () => {
        throw new Error("network down");
      },
    );
    expect(result.status.logged_in).toBe(true);
    expect(result.taskError).toBe("network down");
  });
});
