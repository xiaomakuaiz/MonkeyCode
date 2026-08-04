// 侧栏(旧 UI 设计基线):面板头计数、两行式行 + 状态尾注、右键行菜单、
// 行内重命名、项目组(hover 快捷新建/拖拽)、归档小节沉在组内与底部、
// 折叠态契约键持久化、搜索强制展开。断言按 role/文本,不断类名。
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionMeta } from "@/lib/ipc/sessions";
import type { SidebarActions } from "./Sidebar";
import { Sidebar } from "./Sidebar";

afterEach(() => localStorage.clear());

const meta = (over: Partial<SessionMeta> & { id: string; workdir: string }): SessionMeta => ({
  title: over.id,
  model: "m",
  turns: 0,
  status: "idle",
  ...over,
});

const SESSIONS: SessionMeta[] = [
  meta({ id: "修复登录", workdir: "/p/alpha", updated_at: "2026-08-03", turns: 3, summary: "修复了闪退,补了用例" }),
  meta({ id: "重构侧栏", workdir: "/p/alpha", updated_at: "2026-08-02", waiting_ask: true }),
  meta({ id: "旧任务", workdir: "/p/beta", updated_at: "2026-08-01", archived: true }),
  meta({ id: "闲聊", workdir: "/hidden/c1", kind: "chat", summary: "问了个问题" }),
];

function actions(over: Partial<SidebarActions> = {}): SidebarActions {
  return {
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onToggleArchive: vi.fn(),
    onRename: vi.fn(),
    onNewTask: vi.fn(),
    onNewTaskIn: vi.fn(),
    ...over,
  };
}

/** 行右键后取命令式菜单(backdrop + menu 追加在 body 末尾)。 */
function contextMenuOf(el: HTMLElement): HTMLElement {
  fireEvent.contextMenu(el);
  return document.body.lastElementChild as HTMLElement;
}

const rowOf = (text: string) => screen.getByText(text).closest('[role="button"]') as HTMLElement;

describe("侧栏(local 空间)", () => {
  it("面板头:空间标题 + 项目/任务计数;新建按钮", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={acts} />);
    expect(screen.getByText("本地项目")).toBeTruthy();
    expect(screen.getByText("2 个项目 · 2 个任务")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    expect(acts.onNewTask).toHaveBeenCalled();
  });

  it("按项目分组:行可选中;两行式带摘要行;状态尾注(等待确认着色/静默态给轮次)", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={acts} />);
    expect(screen.getByText("alpha")).toBeTruthy();
    // 两行式:标题行 + 引擎摘要行
    expect(within(rowOf("修复登录")).getByText("修复了闪退,补了用例")).toBeTruthy();
    // 尾注:idle 有轮次给「N 轮」;waiting_ask 给「等待确认」
    expect(within(rowOf("修复登录")).getByText("3 轮")).toBeTruthy();
    expect(within(rowOf("重构侧栏")).getByText("等待确认")).toBeTruthy();
    await userEvent.click(screen.getByText("修复登录"));
    expect(acts.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "修复登录" }));
  });

  it("归档任务收进项目内「已归档任务」小节(默认收起,点开展示);chat 会话不出现在 local 空间", async () => {
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={actions()} />);
    expect(screen.queryByText("问了个问题")).toBeNull();
    // beta 项目只有归档任务:组头在,行默认不渲染
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.queryByText("旧任务")).toBeNull();
    await userEvent.click(screen.getByText("已归档任务 · 1"));
    expect(screen.getByText("旧任务")).toBeTruthy();
    // 开合态落契约键(JSON string[])
    expect(JSON.parse(localStorage.getItem("mc.sessionArchivesOpen") ?? "[]")).toContain("/p/beta");
  });

  it("搜索过滤;无结果空态;清空按钮复位", async () => {
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={actions()} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索会话" }), "登录");
    expect(screen.getByText("修复登录")).toBeTruthy();
    expect(screen.queryByText("重构侧栏")).toBeNull();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索会话" }), "zzz");
    expect(screen.getByText("没有匹配的任务")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect((screen.getByRole("searchbox", { name: "搜索会话" }) as HTMLInputElement).value).toBe("");
    expect(screen.getByText("重构侧栏")).toBeTruthy();
  });

  it("搜索非空强制展开折叠组(不写盘):命中不被折叠藏住", async () => {
    localStorage.setItem("mc.collapsedGroups", JSON.stringify(["/p/alpha"]));
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={actions()} />);
    expect(screen.queryByText("修复登录")).toBeNull(); // 折叠中不渲染
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索会话" }), "登录");
    expect(screen.getByText("修复登录")).toBeTruthy();
    expect(localStorage.getItem("mc.collapsedGroups")).toBe(JSON.stringify(["/p/alpha"]));
  });

  it("行右键菜单:归档直接触发;删除二段确认", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={acts} />);
    let menu = contextMenuOf(rowOf("修复登录"));
    await userEvent.click(within(menu).getByText("归档"));
    expect(acts.onToggleArchive).toHaveBeenCalledWith(expect.objectContaining({ id: "修复登录" }));

    menu = contextMenuOf(rowOf("修复登录"));
    await userEvent.click(within(menu).getByText("删除"));
    expect(acts.onDelete).not.toHaveBeenCalled(); // 第一次点只换文案
    await userEvent.click(within(menu).getByText("确认删除"));
    expect(acts.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "修复登录" }));
  });

  it("重命名:右键菜单进入行内输入,Enter 提交新标题", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={acts} />);
    const menu = contextMenuOf(rowOf("修复登录"));
    await userEvent.click(within(menu).getByText("重命名"));
    const input = screen.getByRole("textbox", { name: "重命名" });
    await userEvent.clear(input);
    await userEvent.type(input, "登录修完了{Enter}");
    expect(acts.onRename).toHaveBeenCalledWith(expect.objectContaining({ id: "修复登录" }), "登录修完了");
    expect(screen.queryByRole("textbox", { name: "重命名" })).toBeNull();
  });

  it("项目组头:hover 快捷「在此项目新建任务」带项目目录回调", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={acts} />);
    // alpha 在前(组按活跃度排序)
    await userEvent.click(screen.getAllByRole("button", { name: "在此项目新建任务" })[0] as HTMLElement);
    expect(acts.onNewTaskIn).toHaveBeenCalledWith("/p/alpha");
  });

  it("项目组头右键:在此新建任务 / 归档项目", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={acts} />);
    const header = screen.getByText("alpha").closest('[role="button"]') as HTMLElement;
    const menu = contextMenuOf(header);
    expect(within(menu).getByText("在此新建任务")).toBeTruthy();
    await userEvent.click(within(menu).getByText("归档项目"));
    // 项目沉入底部「已归档项目 · 1」,并落契约键
    expect(screen.getByText("已归档项目 · 1")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("mc.archivedProjects") ?? "[]")).toContain("/p/alpha");
  });
});

describe("侧栏(chat/cloud 空间)", () => {
  it("chat 空间:面板头计数;平铺对话主行用摘要", () => {
    render(<Sidebar space="chat" sessions={SESSIONS} currentId={null} actions={actions()} />);
    expect(screen.getByText("1 个独立会话")).toBeTruthy();
    expect(screen.getByText("问了个问题")).toBeTruthy();
    expect(screen.queryByText("修复登录")).toBeNull();
  });

  it("chat 归档小节:mc.archivedOpen 契约键(\"1\" 预置即展开)", () => {
    localStorage.setItem("mc.archivedOpen", "1");
    const withArchived = [...SESSIONS, meta({ id: "老对话", workdir: "/hidden/c2", kind: "chat", archived: true })];
    render(<Sidebar space="chat" sessions={withArchived} currentId={null} actions={actions()} />);
    expect(screen.getByText("已归档会话 · 1")).toBeTruthy();
    expect(screen.getByText("老对话")).toBeTruthy();
  });

  it("cloud 空间渲染云端任务列表(无数据时空态)", async () => {
    render(<Sidebar space="cloud" sessions={SESSIONS} currentId={null} actions={actions()} />);
    expect(await screen.findByText("还没有云端项目或任务")).toBeTruthy();
  });
});

describe("后台提醒 attention(D3)", () => {
  it("命中会话:行进入 attention 态;未命中不受影响", () => {
    render(
      <Sidebar
        space="local"
        sessions={SESSIONS}
        currentId={null}
        actions={actions()}
        attentionIds={new Set(["修复登录"])}
      />,
    );
    expect(rowOf("修复登录").dataset.attention).toBeDefined();
    expect(rowOf("重构侧栏").dataset.attention).toBeUndefined();
  });

  it("chat 空间同样生效", () => {
    render(
      <Sidebar space="chat" sessions={SESSIONS} currentId={null} actions={actions()} attentionIds={new Set(["闲聊"])} />,
    );
    expect(rowOf("问了个问题").dataset.attention).toBeDefined();
  });
});
