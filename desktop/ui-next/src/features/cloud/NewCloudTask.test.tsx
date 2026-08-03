// 新建云端任务:三选器默认值、locked 禁选、提交契约(假壳 invoke)。
import { render, screen } from "@testing-library/react";
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

function stubShell(created: Record<string, unknown>[] = []) {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "mc_task_options") return Promise.resolve(OPTIONS);
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
    const model = await screen.findByLabelText<HTMLSelectElement>("模型");
    expect(model.value).toBe("m-basic");
    const lockedOption = [...model.options].find((o) => o.value === "m-ultra");
    expect(lockedOption?.disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>("宿主机").value).toBe("public_host");
    expect(screen.getByLabelText<HTMLSelectElement>("镜像").value).toBe("i-devbox");
    // 公共模型 → 宿主机锁定公共档
    expect(screen.getByLabelText<HTMLSelectElement>("宿主机").disabled).toBe(true);
  });

  it("私有模型解锁宿主机选择;提交带四要素;成功回调", async () => {
    const created: Record<string, unknown>[] = [];
    stubShell(created);
    const onCreated = vi.fn();
    render(<NewCloudTask onCreated={onCreated} />);
    const model = await screen.findByLabelText<HTMLSelectElement>("模型");
    await userEvent.selectOptions(model, "m-mine");
    const host = screen.getByLabelText<HTMLSelectElement>("宿主机");
    expect(host.disabled).toBe(false);
    await userEvent.selectOptions(host, "h-1");
    await userEvent.type(screen.getByLabelText("任务描述"), "给我修个 bug");
    await userEvent.click(screen.getByText("创建"));
    expect(created).toEqual([
      { req: { content: "给我修个 bug", model_id: "m-mine", host_id: "h-1", image_id: "i-devbox" } },
    ]);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "new-task" }));
  });

  it("空描述拦截外显", async () => {
    stubShell();
    render(<NewCloudTask onCreated={() => {}} />);
    await screen.findByLabelText("模型");
    await userEvent.click(screen.getByText("创建"));
    expect((await screen.findByRole("alert")).textContent).toContain("请填写任务描述");
  });
});
