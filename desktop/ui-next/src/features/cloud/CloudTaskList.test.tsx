// 云端任务列表(旧 UI 设计基线):进行中区、历史任务小节(契约键持久化)、
// 项目分组懒拉、行右键(终止/删除二段确认)、选择回调(假壳 invoke)。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** 行右键后取命令式菜单(backdrop + menu 追加在 body 末尾)。 */
function contextMenuOf(el: HTMLElement): HTMLElement {
  fireEvent.contextMenu(el);
  return document.body.lastElementChild as HTMLElement;
}

const rowOf = (text: string) => screen.getByText(text).closest("a") as HTMLElement;

describe("CloudTaskList", () => {
  it("进行中置顶(状态尾注「运行中」),历史收进「历史任务 · N」小节(默认收起);点击回调", async () => {
    stubShell((cmd) => {
      if (cmd === "mc_tasks") return Promise.resolve({ tasks, page_info: { total: 3 } });
      return Promise.resolve({});
    });
    const onSelect = vi.fn();
    render(<CloudTaskList currentId={null} onSelect={onSelect} />);
    await screen.findByText("修复登录");
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(within(rowOf("修复登录")).getByText("运行中")).toBeTruthy();
    // 历史默认收起(未持久化过;details 形态,内容在 DOM 但段收合)
    const history = screen.getByText("历史任务 · 2").closest("details") as HTMLDetailsElement;
    expect(history.open).toBe(false);
    await userEvent.click(screen.getByText("历史任务 · 2"));
    expect(history.open).toBe(true);
    expect(screen.getByText("旧任务甲")).toBeTruthy(); // title 缺省回退 summary
    expect(within(rowOf("旧任务乙")).getByText("运行出错")).toBeTruthy(); // 再回退 content;error 着色词
    expect(within(rowOf("旧任务甲")).getByText("已完成")).toBeTruthy();
    await userEvent.click(screen.getByText("旧任务甲"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
    // 开合态落契约键
    expect(localStorage.getItem("mc.cloudHistoryOpen")).toBe("1");
  });

  it("mc.cloudHistoryOpen 预置 \"1\":历史直接展开", async () => {
    localStorage.setItem("mc.cloudHistoryOpen", "1");
    stubShell((cmd) => (cmd === "mc_tasks" ? Promise.resolve({ tasks, page_info: { total: 3 } }) : Promise.resolve({})));
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    await screen.findByText("修复登录");
    expect((screen.getByText("历史任务 · 2").closest("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("空列表:空态文案", async () => {
    stubShell((cmd) =>
      cmd === "mc_tasks" ? Promise.resolve({ tasks: [], page_info: { total: 0 } }) : Promise.resolve({}),
    );
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    await screen.findByText("还没有云端项目或任务");
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

  it("项目分组:「项目」区出组头,展开按 project_id 懒拉;快速开始组按 quick_start 懒拉", async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    stubShell((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "mc_projects") return Promise.resolve({ projects: [{ id: "p1", name: "支付服务" }] });
      if (cmd !== "mc_tasks") return Promise.resolve({});
      if (args?.projectId === "p1") return Promise.resolve({ tasks: [{ id: "t1", title: "项目内任务", status: "finished" }] });
      if (args?.quickStart) return Promise.resolve({ tasks: [], page_info: { total: 0 } });
      return Promise.resolve({ tasks, page_info: { total: 3 } });
    });
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    await screen.findByText("支付服务");
    expect(screen.getByText("项目")).toBeTruthy();
    expect(screen.queryByText("项目内任务")).toBeNull();
    await userEvent.click(screen.getByText("支付服务"));
    expect(await screen.findByText("项目内任务")).toBeTruthy();
    await userEvent.click(screen.getByText("快速开始"));
    await screen.findByText("暂无任务");
    expect(calls.some((c) => c.cmd === "mc_tasks" && c.args?.quickStart === true)).toBe(true);
  });

  it("行右键删除:二段确认 → mc_task_delete → 整表重拉 + onDeleted 回调", async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    stubShell((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "mc_tasks") return Promise.resolve({ tasks, page_info: { total: 3 } });
      if (cmd === "mc_task_delete") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    const onDeleted = vi.fn();
    render(<CloudTaskList currentId={null} onSelect={() => {}} onDeleted={onDeleted} />);
    await screen.findByText("修复登录");
    const menu = contextMenuOf(rowOf("修复登录"));
    await userEvent.click(within(menu).getByText("删除任务"));
    expect(calls.some((c) => c.cmd === "mc_task_delete")).toBe(false); // 一次点击不执行
    await userEvent.click(within(menu).getByText("确认删除"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "mc_task_delete" && c.args?.id === "a")).toBe(true));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("a"));
  });

  it("删除被服务端拒绝(任务仍在运行):原因外显,不静默", async () => {
    stubShell((cmd) => {
      if (cmd === "mc_tasks") return Promise.resolve({ tasks, page_info: { total: 3 } });
      if (cmd === "mc_task_delete") return Promise.reject(new Error("任务仍在运行"));
      return Promise.resolve({});
    });
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    await screen.findByText("修复登录");
    const menu = contextMenuOf(rowOf("修复登录"));
    await userEvent.click(within(menu).getByText("删除任务"));
    await userEvent.click(within(menu).getByText("确认删除"));
    await screen.findByText(/删除任务失败.*任务仍在运行/);
  });

  it("终止任务:仅运行中行出菜单项,二段确认 → mc_task_stop → 整表重拉", async () => {
    localStorage.setItem("mc.cloudHistoryOpen", "1");
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    stubShell((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "mc_tasks") return Promise.resolve({ tasks, page_info: { total: 3 } });
      if (cmd === "mc_task_stop") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    render(<CloudTaskList currentId={null} onSelect={() => {}} />);
    await screen.findByText("修复登录");
    // 已完成行右键:没有终止项
    let menu = contextMenuOf(rowOf("旧任务甲"));
    expect(within(menu).queryByText("终止任务")).toBeNull();
    fireEvent.mouseDown(menu.previousElementSibling as HTMLElement); // 关掉这层菜单

    menu = contextMenuOf(rowOf("修复登录"));
    await userEvent.click(within(menu).getByText("终止任务"));
    expect(calls.some((c) => c.cmd === "mc_task_stop")).toBe(false);
    await userEvent.click(within(menu).getByText("确认终止"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "mc_task_stop" && c.args?.id === "a")).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "mc_tasks").length).toBeGreaterThanOrEqual(2));
  });

  it("总数超已载:历史段出「加载更多」并续拉合并", async () => {
    localStorage.setItem("mc.cloudHistoryOpen", "1");
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

  it("query:过滤行并强制展开历史", async () => {
    stubShell((cmd) => (cmd === "mc_tasks" ? Promise.resolve({ tasks, page_info: { total: 3 } }) : Promise.resolve({})));
    render(<CloudTaskList currentId={null} onSelect={() => {}} query="旧任务甲" />);
    await screen.findByText("旧任务甲"); // 历史被强制展开且命中
    expect(screen.queryByText("修复登录")).toBeNull();
    expect(screen.queryByText("旧任务乙")).toBeNull();
  });
});
