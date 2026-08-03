import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("壳骨架(P1)", () => {
  it("三栏齐全:空间导航 / 会话列表 / 主区", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "空间导航" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "会话列表" })).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
  });

  it("浏览器模式:不渲染 Windows 标题栏与 mac 红绿灯", () => {
    render(<App />);
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    expect(screen.queryByRole("button", { name: "缩放" })).toBeNull();
  });

  it("Windows 壳:渲染 36px 标题栏三键", () => {
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: () => Promise.resolve(false) },
      event: { listen: () => Promise.resolve(() => {}) },
    };
    vi.stubGlobal("navigator", { ...window.navigator, userAgent: "Windows NT 10.0" });
    render(<App />);
    expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("mac 壳:红绿灯替身在导航 rail 内,无 Windows 三键", () => {
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: () => Promise.resolve(false) },
      event: { listen: () => Promise.resolve(() => {}) },
    };
    vi.stubGlobal("navigator", { ...window.navigator, userAgent: "Macintosh; Intel Mac OS X 10_15_7" });
    render(<App />);
    const rail = screen.getByRole("navigation", { name: "空间导航" });
    const zoom = screen.getByRole("button", { name: "缩放" });
    expect(rail.contains(zoom)).toBe(true);
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
  });
});

describe("设置入口(外观/语言/配置在 SettingsView,各有专测)", () => {
  it("rail 齿轮打开设置页,关闭回到欢迎页", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("combobox", { name: "外观主题" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByText("开始一个任务")).toBeTruthy();
  });
});
