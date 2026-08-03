import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineBanner } from "./EngineBanner";

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

type Emit = (s: unknown) => void;

function stubShell(snapshot: unknown) {
  const calls: string[] = [];
  let emit: Emit = () => {};
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string) => {
        calls.push(cmd);
        if (cmd === "engine_status") return Promise.resolve(snapshot);
        return Promise.resolve(null);
      },
    },
    event: {
      listen: (name: string, cb: (e: { payload: unknown }) => void) => {
        if (name === "engine-status") emit = (s) => cb({ payload: s });
        return Promise.resolve(() => {});
      },
    },
  };
  return { calls, emit: (s: unknown) => emit(s) };
}

describe("引擎状态横幅", () => {
  it("ready 不渲染;崩溃事件到达即亮错误横幅,可重启/开日志", async () => {
    const { calls, emit } = stubShell({ phase: "ready", version: "1.0" });
    const { container } = render(<EngineBanner />);
    await act(() => Promise.resolve());
    expect(container.querySelector('[role="alert"]')).toBeNull();

    act(() => emit({ phase: "crashed", detail: "OOM", log_tail: "", attempt: 2, retry_in_ms: null }));
    expect(screen.getByRole("alert").textContent).toContain("OOM");
    await userEvent.click(screen.getByRole("button", { name: "重启引擎" }));
    expect(calls).toContain("engine_restart");
    await userEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(calls).toContain("open_log_dir");
  });

  it("starting 有 3 秒宽限:快启动不闪横幅,超时才显示", async () => {
    vi.useFakeTimers();
    const { emit } = stubShell({ phase: "starting", attempt: 1 });
    const { container } = render(<EngineBanner />);
    await act(() => Promise.resolve());
    expect(container.querySelector('[role="status"]')).toBeNull();

    act(() => vi.advanceTimersByTime(3100));
    expect(screen.getByRole("status").textContent).toContain("第 1 次");

    // 宽限内转 ready:横幅从未出现过的路径
    act(() => emit({ phase: "ready", version: "1.0" }));
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("failed 显示错误并可重启", async () => {
    stubShell({ phase: "failed", error: "端口被占用" });
    render(<EngineBanner />);
    await act(() => Promise.resolve());
    expect(screen.getByRole("alert").textContent).toContain("端口被占用");
  });
});
