// 云端任务列表:运行中置顶、项目分组懒拉、行菜单删除、历史折叠段、
// 选择回调(假壳 invoke)。
import { render, screen, waitFor, within } from "@testing-library/react";
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
  localStorage.clear();
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

  it("项目分组:mc_projects 出折叠组,展开按 project_id 懒拉;快速开始组按 quick_start 懒拉", async () => {
    const taskCalls: Record<string, unknown>[] = [];
    stubShell((cmd, args) => {
      if (cmd === "mc_projects") {
        return Promise.resolve({
          projects: [{ id: "p1", name: "项目甲", tasks: [{ id: "a", title: "修复登录", status: "processing" }] }],
        });
      }
      if (cmd !== "mc_tasks") return Promise.resolve({});
      taskCalls.push(args ?? {});
      if (args?.projectId === "p1") return Promise.resolve({ tasks: [{ id: "pt1", title: "项目内旧任务", status: "finished" }] });
      if (args?.quickStart === true) return Promise.resolve({ tasks: [{ id: "q1", title: "快速旧任务", status: "finished" }] });
      return Promise.resolve({ tasks, page_info: { total: 3 } });
    });
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    await screen.findByText("项目甲");
    expect(screen.getByText("快速开始")).toBeTruthy();
    // 运行中仍置顶平铺(捎带任务只做徽标,不重复出行)
    expect(screen.getByText("修复登录")).toBeTruthy();

    await userEvent.click(screen.getByText("项目甲"));
    await screen.findByText("项目内旧任务");
    await userEvent.click(screen.getByText("快速开始"));
    await screen.findByText("快速旧任务");
    expect(taskCalls.some((a) => a.projectId === "p1")).toBe(true);
    expect(taskCalls.some((a) => a.quickStart === true)).toBe(true);
    // 再合上再展开:缓存命中,不重复拉
    const projectLoads = taskCalls.filter((a) => a.projectId === "p1").length;
    await userEvent.click(screen.getByText("项目甲"));
    await userEvent.click(screen.getByText("项目甲"));
    expect(taskCalls.filter((a) => a.projectId === "p1").length).toBe(projectLoads);
  });

  it("行菜单删除:二段确认 → mc_task_delete → 整表重拉 + onDeleted 回调", async () => {
    let listCalls = 0;
    const deleted: string[] = [];
    stubShell((cmd, args) => {
      if (cmd === "mc_tasks") {
        listCalls += 1;
        return Promise.resolve({ tasks, page_info: { total: 3 } });
      }
      if (cmd === "mc_task_delete") {
        deleted.push(String(args?.id));
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });
    const onDeleted = vi.fn();
    render(<CloudTaskList currentId="b" onSelect={() => {}} onDeleted={onDeleted} />);
    const row = (await screen.findByText("旧任务甲")).closest("a") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "任务操作" }));
    await userEvent.click(within(row).getByText("删除任务"));
    expect(deleted).toEqual([]); // 第一段只变文案
    const before = listCalls;
    await userEvent.click(within(row).getByText("确认删除"));
    await waitFor(() => expect(deleted).toEqual(["b"]));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("b"));
    await waitFor(() => expect(listCalls).toBeGreaterThan(before)); // 删除后触发重拉
  });

  it("删除被服务端拒绝(任务仍在运行):原因外显,不静默", async () => {
    stubShell((cmd) => {
      if (cmd === "mc_tasks") return Promise.resolve({ tasks, page_info: { total: 3 } });
      if (cmd === "mc_task_delete") return Promise.reject(new Error("任务仍在运行"));
      return Promise.resolve({});
    });
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    const row = (await screen.findByText("修复登录")).closest("a") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "任务操作" }));
    await userEvent.click(within(row).getByText("删除任务"));
    await userEvent.click(within(row).getByText("确认删除"));
    await screen.findByText(/删除任务失败.*任务仍在运行/);
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

  it("行 meta 与本地侧栏同规:运行中/出错给状态文字,已完成留白", async () => {
    stubShell((cmd) => (cmd === "mc_tasks" ? Promise.resolve({ tasks, page_info: { total: 3 } }) : Promise.resolve({})));
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    const running = (await screen.findByText("修复登录")).closest("a") as HTMLElement;
    expect(within(running).getByText("运行中")).toBeTruthy();
    const errored = screen.getByText("旧任务乙").closest("a") as HTMLElement;
    expect(within(errored).getByText("出错")).toBeTruthy();
    const finished = screen.getByText("旧任务甲").closest("a") as HTMLElement;
    expect(within(finished).queryByText("已完成")).toBeNull();
  });

  it("终止任务:仅运行中行出菜单项,二段确认 → mc_task_stop → 整表重拉", async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    stubShell((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "mc_tasks") return Promise.resolve({ tasks, page_info: { total: 3 } });
      if (cmd === "mc_task_stop") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    const running = (await screen.findByText("修复登录")).closest("a") as HTMLElement;
    // 已完成行没有终止项
    const finished = screen.getByText("旧任务甲").closest("a") as HTMLElement;
    expect(within(finished).queryByText("终止任务")).toBeNull();

    await userEvent.click(within(running).getByRole("button", { name: "任务操作" }));
    await userEvent.click(within(running).getByText("终止任务"));
    expect(calls.some((c) => c.cmd === "mc_task_stop")).toBe(false); // 一次点击不执行
    await userEvent.click(within(running).getByText("确认终止"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "mc_task_stop" && c.args?.id === "a")).toBe(true));
    // 状态翻转后整表重拉
    await waitFor(() => expect(calls.filter((c) => c.cmd === "mc_tasks").length).toBeGreaterThanOrEqual(2));
  });

  it("云端历史开合态持久化(mc.cloudHistoryOpen 契约键)", async () => {
    localStorage.setItem("mc.cloudHistoryOpen", "1");
    stubShell((cmd) => (cmd === "mc_tasks" ? Promise.resolve({ tasks, page_info: { total: 3 } }) : Promise.resolve({})));
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    await screen.findByText("修复登录");
    const details = screen.getByText("云端历史").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });
});
