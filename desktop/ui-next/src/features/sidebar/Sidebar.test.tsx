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
  meta({ id: "修复登录", workdir: "/p/alpha", updated_at: "2026-08-03" }),
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

describe("侧栏(local 空间)", () => {
  it("按项目分组,组内会话行可选中;组头带等待审批计数", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={acts} />);
    expect(screen.getByText("alpha")).toBeTruthy();
    const alphaGroup = screen.getByText("alpha").closest("details");
    expect(alphaGroup && within(alphaGroup as HTMLElement).getByText("修复登录")).toBeTruthy();
    // waiting_ask 计数徽标
    expect(within(alphaGroup as HTMLElement).getByText("1")).toBeTruthy();
    await userEvent.click(screen.getByText("修复登录"));
    expect(acts.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "修复登录" }));
  });

  it("归档会话拍平到底部「已归档」(行 meta 给项目名),全归档的项目不留空组头;chat 会话不出现在 local 空间", () => {
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={actions()} />);
    expect(screen.queryByText("问了个问题")).toBeNull();
    const archived = screen.getByText("已归档").closest("details") as HTMLElement;
    const row = within(archived).getByText("旧任务").closest("a") as HTMLElement;
    // beta 项目的会话全归档:顶部无 beta 组头,行 meta 位标注项目名
    expect(within(row).getByText("beta")).toBeTruthy();
    expect(screen.getByText("beta").closest("details")).toBe(archived);
  });

  it("行 meta 只表要紧状态:等待审批出文字,空闲行留白", () => {
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={actions()} />);
    const waitingRow = screen.getByText("重构侧栏").closest("a") as HTMLElement;
    expect(within(waitingRow).getByText("等待审批")).toBeTruthy();
    const idleRow = screen.getByText("修复登录").closest("a") as HTMLElement;
    expect(within(idleRow).queryByText("等待审批")).toBeNull();
    expect(within(idleRow).queryByText("运行中")).toBeNull();
  });

  it("搜索过滤标题;无结果给空态文案;清空按钮复位", async () => {
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={actions()} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索会话" }), "登录");
    expect(screen.getByText("修复登录")).toBeTruthy();
    expect(screen.queryByText("重构侧栏")).toBeNull();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索会话" }), "zzz");
    expect(screen.getByText("没有匹配的会话")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect((screen.getByRole("searchbox", { name: "搜索会话" }) as HTMLInputElement).value).toBe("");
    expect(screen.getByText("重构侧栏")).toBeTruthy();
  });

  it("搜索非空强制展开折叠组:命中不被折叠藏住", async () => {
    localStorage.setItem("mc.collapsedGroups", JSON.stringify(["/p/alpha"]));
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={actions()} />);
    const group = screen.getByText("alpha").closest("details") as HTMLDetailsElement;
    expect(group.open).toBe(false);
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索会话" }), "登录");
    expect((screen.getByText("alpha").closest("details") as HTMLDetailsElement).open).toBe(true);
    // 强制展开不写盘:折叠偏好保持
    expect(localStorage.getItem("mc.collapsedGroups")).toBe(JSON.stringify(["/p/alpha"]));
  });

  it("行菜单:归档直接触发;删除要二段确认", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={acts} />);
    const row = screen.getByText("修复登录").closest("a") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "会话操作" }));
    await userEvent.click(within(row).getByText("归档"));
    expect(acts.onToggleArchive).toHaveBeenCalled();

    await userEvent.click(within(row).getByText("删除"));
    expect(acts.onDelete).not.toHaveBeenCalled();
    await userEvent.click(within(row).getByText("确认删除"));
    expect(acts.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "修复登录" }));
  });

  it("重命名:菜单点重命名→行原位变输入框,Enter 提交新标题,Esc 取消", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={acts} />);
    const row = screen.getByText("修复登录").closest("a") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "会话操作" }));
    await userEvent.click(within(row).getByText("重命名"));
    const input = screen.getByRole("textbox", { name: "重命名" });
    await userEvent.clear(input);
    await userEvent.type(input, "登录修完了{Enter}");
    expect(acts.onRename).toHaveBeenCalledWith(expect.objectContaining({ id: "修复登录" }), "登录修完了");
    expect(screen.queryByRole("textbox", { name: "重命名" })).toBeNull();
  });

  it("行右键弹出同款菜单:点归档触发动作", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={acts} />);
    const row = screen.getByText("修复登录").closest("a") as HTMLElement;
    fireEvent.contextMenu(row);
    // 命令式菜单追加在 body 末尾(backdrop + menu)
    const menu = document.body.lastElementChild as HTMLElement;
    expect(within(menu).getByText("重命名")).toBeTruthy();
    await userEvent.click(within(menu).getByText("归档"));
    expect(acts.onToggleArchive).toHaveBeenCalledWith(expect.objectContaining({ id: "修复登录" }));
  });

  it("项目组头:「在此项目新建任务」带项目目录回调", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={acts} />);
    await userEvent.click(screen.getByRole("button", { name: "在此项目新建任务" }));
    expect(acts.onNewTaskIn).toHaveBeenCalledWith("/p/alpha");
  });

  it("底部折叠段开合态持久化(mc.archivedOpen 契约键,\"1\"/\"0\")", () => {
    localStorage.setItem("mc.archivedOpen", "1");
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={actions()} />);
    const details = screen.getByText("已归档").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    details.open = false;
    fireEvent(details, new Event("toggle"));
    expect(localStorage.getItem("mc.archivedOpen")).toBe("0");
  });
});

describe("侧栏(chat/cloud 空间)", () => {
  it("chat 空间平铺对话,主行用摘要", () => {
    render(<Sidebar space="chat" sessions={SESSIONS} currentId={null} actions={actions()} />);
    expect(screen.getByText("问了个问题")).toBeTruthy();
    expect(screen.queryByText("修复登录")).toBeNull();
  });

  it("cloud 空间渲染云端任务列表(无数据时空态)", async () => {
    render(<Sidebar space="cloud" sessions={SESSIONS} currentId={null} actions={actions()} />);
    expect(await screen.findByText("还没有云端任务")).toBeTruthy();
  });

  it("新建任务按钮", async () => {
    const acts = actions();
    render(<Sidebar space="local" sessions={[]} currentId={null} actions={acts} />);
    await userEvent.click(screen.getByRole("button", { name: "新建任务" }));
    expect(acts.onNewTask).toHaveBeenCalled();
  });
});

describe("后台提醒 attention(D3)", () => {
  it("命中会话:行进入 attention 态(高亮 + 警示点);未命中不受影响", () => {
    render(
      <Sidebar
        space="local"
        sessions={SESSIONS}
        currentId={null}
        actions={actions()}
        attentionIds={new Set(["修复登录"])}
      />,
    );
    const row = screen.getByText("修复登录").closest("a") as HTMLElement;
    expect(row.dataset.attention).toBeDefined();
    const other = screen.getByText("重构侧栏").closest("a") as HTMLElement;
    expect(other.dataset.attention).toBeUndefined();
  });

  it("chat 空间同样生效", () => {
    render(
      <Sidebar space="chat" sessions={SESSIONS} currentId={null} actions={actions()} attentionIds={new Set(["闲聊"])} />,
    );
    const row = screen.getByText("问了个问题").closest("a") as HTMLElement;
    expect(row.dataset.attention).toBeDefined();
  });
});
