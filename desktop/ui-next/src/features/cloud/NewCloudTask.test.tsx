// 新建云端任务:三选器默认值、locked 禁选、提交契约(假壳 invoke)。
// 三选器为 composer 同款菜单(pickers.OptionMenu):触发器 button 文本 =
// 当前选中项展示名,列表 list 与触发器同可及名(role 区分)。
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewCloudTask } from "./NewCloudTask";

const OPTIONS = {
  models: [
    { id: "m-basic", model: "monkeycode-basic-x", owner: { type: "public" }, weight: 1 },
    { id: "m-ultra", model: "monkeycode-ultra-x", owner: { type: "public" }, weight: 9 },
    { id: "m-mine", model: "my-model", owner: { type: "private" } },
  ],
  images: [
    { id: "i-devbox", remark: "devbox", owner: { type: "public" } },
    { id: "i-other", name: "reg/foo:1" },
  ],
  hosts: [{ id: "h-1", name: "私有机", status: "online" }],
  projects: [],
  plan: "", // 免费档:ultra 应 locked
};

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

function stubShell(created: Record<string, unknown>[] = [], options: Record<string, unknown> = OPTIONS) {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "mc_task_options") return Promise.resolve(options);
        if (cmd === "mc_task_create") {
          created.push(args ?? {});
          return Promise.resolve({ id: "new-task", status: "pending" });
        }
        return Promise.resolve({});
      },
    },
  };
}

describe("NewCloudTask", () => {
  it("默认值:免费档选基础模型、公共宿主、devbox 镜像;超档模型禁选", async () => {
    stubShell();
    render(<NewCloudTask onCreated={() => {}} />);
    const model = await screen.findByRole("button", { name: "模型" });
    expect(model.textContent).toContain("基础模型");
    await userEvent.click(model);
    const menu = screen.getByRole("list", { name: "模型" });
    expect((within(menu).getByRole("button", { name: /旗舰模型/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "宿主机" }).textContent).toContain("公共宿主机");
    expect(screen.getByRole("button", { name: "镜像" }).textContent).toContain("devbox");
    // 公共模型 → 宿主机锁定公共档
    expect((screen.getByRole("button", { name: "宿主机" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("私有模型解锁宿主机选择;提交带四要素;成功回调", async () => {
    const created: Record<string, unknown>[] = [];
    stubShell(created);
    const onCreated = vi.fn();
    render(<NewCloudTask onCreated={onCreated} />);
    await userEvent.click(await screen.findByRole("button", { name: "模型" }));
    await userEvent.click(within(screen.getByRole("list", { name: "模型" })).getByRole("button", { name: "my-model" }));
    const host = screen.getByRole("button", { name: "宿主机" }) as HTMLButtonElement;
    expect(host.disabled).toBe(false);
    await userEvent.click(host);
    await userEvent.click(within(screen.getByRole("list", { name: "宿主机" })).getByRole("button", { name: "私有机" }));
    await userEvent.type(screen.getByLabelText("任务描述"), "给我修个 bug");
    await userEvent.click(screen.getByText("创建"));
    expect(created).toEqual([
      { req: { content: "给我修个 bug", model_id: "m-mine", host_id: "h-1", image_id: "i-devbox" } },
    ]);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "new-task" }));
  });

  it("默认不关联仓库:提交不带 repo_url/project_id", async () => {
    const created: Record<string, unknown>[] = [];
    stubShell(created);
    render(<NewCloudTask onCreated={() => {}} />);
    expect(await screen.findByRole("button", { name: "关联仓库" })).toBeDefined();
    expect(screen.getByRole("button", { name: "关联仓库" }).textContent).toContain("不关联仓库");
    await userEvent.type(screen.getByLabelText("任务描述"), "随便聊聊");
    await userEvent.click(screen.getByText("创建"));
    const req = created[0]!.req as Record<string, unknown>;
    expect(req.repo_url).toBeUndefined();
    expect(req.project_id).toBeUndefined();
  });

  it("手输仓库地址:校验后进触发器,提交带 repo_url", async () => {
    const created: Record<string, unknown>[] = [];
    stubShell(created);
    render(<NewCloudTask onCreated={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "关联仓库" }));

    // 非 Git 地址就地拦截,不落到触发器
    await userEvent.type(screen.getByLabelText("手动输入仓库地址"), "not-a-repo");
    await userEvent.click(screen.getByRole("button", { name: "使用" }));
    expect((await screen.findByRole("alert")).textContent).toContain("有效的 Git 地址");

    await userEvent.clear(screen.getByLabelText("手动输入仓库地址"));
    await userEvent.type(screen.getByLabelText("手动输入仓库地址"), "https://github.com/o/repo.git");
    await userEvent.click(screen.getByRole("button", { name: "使用" }));
    expect(screen.getByRole("button", { name: "关联仓库" }).textContent).toContain("repo");

    await userEvent.type(screen.getByLabelText("任务描述"), "改点东西");
    await userEvent.click(screen.getByText("创建"));
    const req = created[0]!.req as Record<string, unknown>;
    expect(req.repo_url).toBe("https://github.com/o/repo.git");
    expect(req.project_id).toBeUndefined();
  });

  it("选云端项目:提交带 project_id 与其 repo_url,并顶掉此前手输的地址", async () => {
    const created: Record<string, unknown>[] = [];
    stubShell(created, {
      ...OPTIONS,
      projects: [{ id: "p1", name: "阿尔法", repo_url: "https://git/o/alpha.git" }],
    });
    render(<NewCloudTask onCreated={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "关联仓库" }));
    await userEvent.type(screen.getByLabelText("手动输入仓库地址"), "https://github.com/o/repo.git");
    await userEvent.click(screen.getByRole("button", { name: "使用" }));

    await userEvent.click(screen.getByRole("button", { name: "关联仓库" }));
    await userEvent.click(screen.getByRole("button", { name: "阿尔法" }));
    expect(screen.getByRole("button", { name: "关联仓库" }).textContent).toContain("阿尔法");

    await userEvent.type(screen.getByLabelText("任务描述"), "接着干");
    await userEvent.click(screen.getByText("创建"));
    expect((created[0]!.req as Record<string, unknown>).project_id).toBe("p1");
    expect((created[0]!.req as Record<string, unknown>).repo_url).toBe("https://git/o/alpha.git");
  });

  it("预选项目(侧栏项目组头「+」入口):触发器直接落在该项目上", async () => {
    stubShell([], { ...OPTIONS, projects: [{ id: "p1", name: "阿尔法", repo_url: "https://git/o/alpha.git" }] });
    render(<NewCloudTask onCreated={() => {}} initialProject={{ id: "p1", name: "阿尔法" }} />);
    expect((await screen.findByRole("button", { name: "关联仓库" })).textContent).toContain("阿尔法");
  });

  it("空描述拦截外显", async () => {
    stubShell();
    render(<NewCloudTask onCreated={() => {}} />);
    await screen.findByRole("button", { name: "模型" });
    await userEvent.click(screen.getByText("创建"));
    expect((await screen.findByRole("alert")).textContent).toContain("请填写任务描述");
  });
});
