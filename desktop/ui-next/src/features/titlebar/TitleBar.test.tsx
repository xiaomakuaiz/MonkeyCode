import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MacWindowControls, TitleBar } from "./TitleBar";

afterEach(() => vi.unstubAllGlobals());

function stubShell(ua: string) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const shell = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "plugin:window|is_maximized") return Promise.resolve(false);
        if (cmd === "plugin:window|is_fullscreen") return Promise.resolve(false);
        return Promise.resolve(null);
      },
    },
    event: {
      listen: () => Promise.resolve(() => {}),
    },
  };
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = shell;
  vi.stubGlobal("navigator", { ...window.navigator, userAgent: ua });
  return {
    calls,
    done: () => {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    },
  };
}

describe("Windows 自绘标题栏", () => {
  it("三键齐全,点击各发对应窗口命令;关闭键有独立可达名", async () => {
    const { calls, done } = stubShell("Windows NT 10.0");
    render(<TitleBar />);
    await userEvent.click(screen.getByRole("button", { name: "最小化" }));
    await userEvent.click(screen.getByRole("button", { name: "最大化" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    const cmds = calls.map((c) => c.cmd);
    expect(cmds).toContain("plugin:window|minimize");
    expect(cmds).toContain("plugin:window|toggle_maximize");
    expect(cmds).toContain("plugin:window|close");
    done();
  });

  it("拖拽热区:条与每个可见非交互子节点自带属性,按钮不带(Tauri 不继承判定)", () => {
    const { done } = stubShell("Windows NT 10.0");
    const { container } = render(<TitleBar />);
    const bar = container.querySelector("[data-window-titlebar]");
    expect(bar?.hasAttribute("data-tauri-drag-region")).toBe(true);
    // 分段与品牌字都要能拖
    expect(container.querySelectorAll("[data-tauri-drag-region]").length).toBeGreaterThanOrEqual(4);
    for (const btn of container.querySelectorAll("button")) {
      expect(btn.hasAttribute("data-tauri-drag-region")).toBe(false);
    }
    done();
  });
});

describe("mac 自绘红绿灯", () => {
  it("三颗齐全;绿点默认切全屏、⌥ 点击切最大化", async () => {
    const { calls, done } = stubShell("Macintosh; Intel Mac OS X 10_15_7");
    render(<MacWindowControls />);
    await userEvent.click(screen.getByRole("button", { name: "缩放" }));
    expect(calls.map((c) => c.cmd)).toContain("plugin:window|is_fullscreen");
    expect(calls.at(-1)?.cmd).toBe("plugin:window|set_fullscreen");
    expect(calls.at(-1)?.args).toEqual({ value: true });

    calls.length = 0;
    const user = userEvent.setup();
    await user.keyboard("{Alt>}");
    await user.click(screen.getByRole("button", { name: "缩放" }));
    await user.keyboard("{/Alt}");
    expect(calls.map((c) => c.cmd)).toContain("plugin:window|toggle_maximize");
    done();
  });

  it("窗口失焦落 data-blurred(CSS 据此整组退灰),回焦清除", () => {
    const { done } = stubShell("Macintosh; Intel Mac OS X 10_15_7");
    const { container } = render(<MacWindowControls />);
    const group = container.querySelector("[data-tauri-drag-region]");
    act(() => window.dispatchEvent(new Event("blur")));
    expect(group?.hasAttribute("data-blurred")).toBe(true);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(group?.hasAttribute("data-blurred")).toBe(false);
    done();
  });
});
