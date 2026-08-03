import { render, screen, within } from "@testing-library/react";
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
  return { onSelect: vi.fn(), onDelete: vi.fn(), onToggleArchive: vi.fn(), onNewTask: vi.fn(), ...over };
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

  it("归档会话折叠进「已归档」;chat 会话不出现在 local 空间", () => {
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={actions()} />);
    expect(screen.queryByText("问了个问题")).toBeNull();
    expect(screen.getByText("已归档")).toBeTruthy();
  });

  it("搜索过滤标题;无结果给空态文案", async () => {
    render(<Sidebar space="local" sessions={SESSIONS} currentId={null} actions={actions()} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索会话" }), "登录");
    expect(screen.getByText("修复登录")).toBeTruthy();
    expect(screen.queryByText("重构侧栏")).toBeNull();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索会话" }), "zzz");
    expect(screen.getByText("没有匹配的会话")).toBeTruthy();
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
