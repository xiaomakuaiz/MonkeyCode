import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewTaskModal } from "./NewTaskModal";

afterEach(() => {
  localStorage.clear();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

function stubShell(models = [{ name: "gpt-5", default: true }, { name: "locked-pro", default: false, locked: true }]) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "models_list") return Promise.resolve(models);
        if (cmd === "session_create") return Promise.resolve({ id: "s-new", title: "t", workdir: "/w", model: "gpt-5", turns: 0, status: "created", kind: (args?.kind as string) ?? "local" });
        return Promise.resolve(null);
      },
    },
  };
  return calls;
}

describe("新建任务", () => {
  it("默认本地模式:目录预填 ~/MonkeyCode,模型取默认且锁定项禁选", async () => {
    stubShell();
    render(<NewTaskModal open onClose={() => {}} onCreated={() => {}} />);
    expect((screen.getByRole("textbox", { name: "项目目录" }) as HTMLInputElement).value).toBe("~/MonkeyCode");
    await waitFor(() => expect((screen.getByRole("combobox", { name: "模型" }) as HTMLSelectElement).value).toBe("gpt-5"));
    expect((screen.getByRole("option", { name: "locked-pro" }) as HTMLOptionElement).disabled).toBe(true);
  });

  it("本地 + 默认目录:createDir=true;创建成功回调并记忆模型", async () => {
    const calls = stubShell();
    const onCreated = vi.fn();
    render(<NewTaskModal open onClose={() => {}} onCreated={onCreated} />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "模型" }) as HTMLSelectElement).value).toBe("gpt-5"));
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const create = calls.find((c) => c.cmd === "session_create");
    expect(create?.args).toEqual({ workdir: "~/MonkeyCode", model: "gpt-5", createDir: true, kind: "local" });
    expect(localStorage.getItem("mc.lastTaskModel")).toBe("gpt-5");
  });

  it("对话模式:workdir 空串、createDir=false、无目录字段", async () => {
    const calls = stubShell();
    const onCreated = vi.fn();
    render(<NewTaskModal open onClose={() => {}} onCreated={onCreated} />);
    await userEvent.click(screen.getByRole("tab", { name: "普通对话" }));
    expect(screen.queryByRole("textbox", { name: "项目目录" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const create = calls.find((c) => c.cmd === "session_create");
    expect(create?.args).toEqual({ workdir: "", model: "gpt-5", createDir: false, kind: "chat" });
  });

  it("本地模式清空目录:前端拦截并提示,不发命令", async () => {
    const calls = stubShell();
    render(<NewTaskModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.clear(screen.getByRole("textbox", { name: "项目目录" }));
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(screen.getByRole("alert").textContent).toContain("请先选择项目目录");
    expect(calls.some((c) => c.cmd === "session_create")).toBe(false);
  });

  it("创建失败:错误文案外显(壳的 Err 是中文,直接展示)", async () => {
    stubShell();
    (window as unknown as { __TAURI__?: { core: { invoke: (c: string) => Promise<unknown> } } }).__TAURI__ = {
      core: {
        invoke: (cmd: string) =>
          cmd === "models_list" ? Promise.resolve([{ name: "m", default: true }]) : Promise.reject(new Error("目录不存在")),
      },
    };
    render(<NewTaskModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("目录不存在"));
  });
});
