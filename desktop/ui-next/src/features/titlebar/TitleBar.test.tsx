import { act, fireEvent, render, screen } from "@testing-library/react";
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

describe("自绘窗框条(Windows / Linux)", () => {
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

  it("拖拽热区:条与中间空白自带属性,按钮一个都不带(Tauri 不继承判定)", () => {
    const { done } = stubShell("Windows NT 10.0");
    const { container } = render(<TitleBar />);
    const bar = container.querySelector("[data-window-titlebar]");
    expect(bar?.hasAttribute("data-tauri-drag-region")).toBe(true);
    // 条本身 + 图标与三键之间那段空白(列宽分段已撤,见下条)
    expect(container.querySelectorAll("[data-tauri-drag-region]").length).toBe(2);
    for (const btn of container.querySelectorAll("button")) {
      expect(btn.hasAttribute("data-tauri-drag-region")).toBe(false);
    }
    done();
  });

  it("不放品牌:品牌的法定位置只有侧栏头,两处都摆会变成上下两个 header", () => {
    const { done } = stubShell("Windows NT 10.0");
    render(<TitleBar />);
    expect(screen.queryByText("MonkeyCode")).toBeNull();
    expect(screen.queryByText("work")).toBeNull();
    done();
  });

  // 2026-08-08 定案:光删掉品牌文字不够——条按 rail/side/main 复刻列色时,
  // base-200 色块紧贴着下面又一个 base-200 侧栏头,那才是「两个 header」的
  // 成因。窗框必须与内容断色:整条单色、无底边线。
  it("不承列色、不带底边线:整条单色,才不会冒充成第二个 header", () => {
    const { done } = stubShell("Windows NT 10.0");
    const { container } = render(<TitleBar />);
    const bar = container.querySelector("[data-window-titlebar]") as HTMLElement;
    expect(bar.className).toContain("bg-base-300");
    expect(bar.className).not.toContain("border-b");
    // 列宽令牌一个都不许再出现在窗框条里
    expect(container.innerHTML).not.toMatch(/w-rail|w-side|bg-base-200/);
    done();
  });

  it("左端应用图标:Windows 上点击开系统菜单、双击关窗", async () => {
    const { calls, done } = stubShell("Windows NT 10.0");
    render(<TitleBar />);
    const icon = screen.getByRole("button", { name: "系统菜单" });
    expect(icon.hasAttribute("data-tauri-drag-region")).toBe(false);
    await userEvent.click(icon);
    expect(calls.map((c) => c.cmd)).toContain("window_system_menu");
    await userEvent.dblClick(icon);
    expect(calls.map((c) => c.cmd)).toContain("plugin:window|close");
    done();
  });

  it("条右键 = 系统菜单(无边框窗口丢掉的原生右键菜单补回来)", () => {
    const { calls, done } = stubShell("Windows NT 10.0");
    const { container } = render(<TitleBar />);
    fireEvent.contextMenu(container.querySelector("[data-window-titlebar]")!);
    expect(calls.map((c) => c.cmd)).toContain("window_system_menu");
    done();
  });

  it("Linux 同样自绘本条(壳一并走 CSD),但系统菜单是 Windows 专有", async () => {
    const { calls, done } = stubShell("X11; Linux x86_64");
    const { container } = render(<TitleBar />);
    expect(container.querySelector("[data-window-titlebar]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
    // GTK 侧无对等 API:图标纯展示,右键与点击都不发命令
    fireEvent.contextMenu(container.querySelector("[data-window-titlebar]")!);
    await userEvent.click(screen.getByRole("button", { name: "系统菜单" }));
    expect(calls.map((c) => c.cmd)).not.toContain("window_system_menu");
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
