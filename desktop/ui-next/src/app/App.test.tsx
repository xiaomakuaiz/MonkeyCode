import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionMeta } from "@/lib/ipc/sessions";
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

  it("mac 壳:红绿灯在 rail 左上角(chrome 角落),无 Windows 三键", () => {
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: () => Promise.resolve(false) },
      event: { listen: () => Promise.resolve(() => {}) },
    };
    vi.stubGlobal("navigator", { ...window.navigator, userAgent: "Macintosh; Intel Mac OS X 10_15_7" });
    render(<App />);
    const zoom = screen.getByRole("button", { name: "缩放" });
    // 骨架规范:红绿灯待在 rail 顶部的 chrome 角落(与各列 h-11 头部同基线)
    expect(screen.getByRole("navigation", { name: "空间导航" }).contains(zoom)).toBe(true);
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
  });
});

describe("设置入口(外观/语言/配置在 SettingsView,各有专测)", () => {
  it("rail 齿轮打开设置页,关闭回到欢迎页", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    // 设置页标志改认页头标题:初始分区已是「账号」(登录主路径),不再是通用
    expect(screen.getByRole("heading", { name: "设置" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByText("开始一个任务")).toBeTruthy();
  });
});

/* ==================== 批 A:D1/D3/D5/D8/H9 的 App 级粘合 ==================== */

const sess = (over: Partial<SessionMeta> & { id: string }): SessionMeta => ({
  title: over.id,
  workdir: "/p/a",
  model: "m",
  turns: 0,
  status: "idle",
  ...over,
});

interface Call {
  cmd: string;
  args?: Record<string, unknown>;
}

/** 桌面壳桩:支持同名事件多监听(App 与 EngineBanner 都听 engine-status)。 */
function stubShell(opts: { sessions?: SessionMeta[]; models?: unknown[]; intent?: string | null } = {}) {
  const calls: Call[] = [];
  const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "sessions_list") return Promise.resolve(opts.sessions ?? []);
        if (cmd === "models_list") return Promise.resolve(opts.models ?? [{ name: "m", default: true }]);
        if (cmd === "take_ui_intent") return Promise.resolve(opts.intent ?? null);
        if (cmd === "engine_status") return Promise.resolve({ phase: "ready", version: "1" });
        if (cmd === "session_open") return Promise.resolve({ frames: [], cursor: 0, has_more: false });
        if (cmd === "host_info") return Promise.resolve({ version: "1", engine_version: "1" });
        if (cmd === "sound_enabled") return Promise.resolve(true);
        return Promise.resolve(null);
      },
    },
    event: {
      listen: (name: string, cb: (e: { payload: unknown }) => void) => {
        const set = listeners.get(name) ?? new Set();
        set.add(cb);
        listeners.set(name, set);
        return Promise.resolve(() => set.delete(cb));
      },
    },
  };
  return {
    calls,
    count: (cmd: string) => calls.filter((c) => c.cmd === cmd).length,
    emit: (name: string, payload: unknown) => listeners.get(name)?.forEach((cb) => cb({ payload })),
  };
}

describe("D1 引擎重启自愈", () => {
  it("引擎曾不可用后转 ready:重拉会话列表并幂等重开当前会话", async () => {
    localStorage.setItem("mc.lastSession", "s1");
    localStorage.setItem("mc.sidebarSpace", "local");
    const shell = stubShell({ sessions: [sess({ id: "s1", title: "任务一" })] });
    render(<App />);
    await waitFor(() => expect(shell.count("session_open")).toBe(1));
    const listBefore = shell.count("sessions_list");

    act(() => shell.emit("engine-status", { phase: "crashed", detail: "x", log_tail: "", attempt: 1, retry_in_ms: 1000 }));
    act(() => shell.emit("engine-status", { phase: "ready", version: "1" }));
    await waitFor(() => expect(shell.count("session_open")).toBe(2)); // epoch 信号驱动重开
    expect(shell.count("sessions_list")).toBeGreaterThan(listBefore);
  });

  it("一直 ready(没掉过)不空转:不重拉不重开", async () => {
    localStorage.setItem("mc.lastSession", "s1");
    const shell = stubShell({ sessions: [sess({ id: "s1" })] });
    render(<App />);
    await waitFor(() => expect(shell.count("session_open")).toBe(1));
    const listBefore = shell.count("sessions_list");
    act(() => shell.emit("engine-status", { phase: "ready", version: "1" }));
    await act(() => Promise.resolve());
    expect(shell.count("session_open")).toBe(1);
    expect(shell.count("sessions_list")).toBe(listBefore);
  });
});

describe("D3 后台会话提醒", () => {
  it("非当前会话等待审批:出可点击提示,点击跳转并按 kind 切空间", async () => {
    localStorage.setItem("mc.lastSession", "s1");
    const shell = stubShell({
      sessions: [sess({ id: "s1", title: "任务一" }), sess({ id: "c1", title: "闲聊会话", kind: "chat" })],
    });
    render(<App />);
    await waitFor(() => expect(shell.count("session_open")).toBe(1));

    act(() => shell.emit("session-event", { type: "session-ask", id: "c1", title: "闲聊会话", open: true }));
    const notice = await screen.findByText("「闲聊会话」等待审批");
    await userEvent.click(notice);
    await waitFor(() =>
      expect(shell.calls.some((c) => c.cmd === "session_open" && c.args?.id === "c1")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "本地会话" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("「闲聊会话」等待审批")).toBeNull(); // 打开即消
  });

  it("终态提醒可关闭,不跳转;当前会话的事件不提醒", async () => {
    localStorage.setItem("mc.lastSession", "s1");
    const shell = stubShell({ sessions: [sess({ id: "s1", title: "任务一" }), sess({ id: "s2", title: "后台任务" })] });
    render(<App />);
    await waitFor(() => expect(shell.count("session_open")).toBe(1));

    // 当前会话的事件:不出提示
    act(() => shell.emit("session-event", { type: "session-status", id: "s1", title: "任务一", status: "idle" }));
    await act(() => Promise.resolve());
    expect(screen.queryByText("「任务一」已回复")).toBeNull();

    act(() => shell.emit("session-event", { type: "session-status", id: "s2", title: "后台任务", status: "error" }));
    expect(await screen.findByText("「后台任务」出错了")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "关闭提醒" }));
    expect(screen.queryByText("「后台任务」出错了")).toBeNull();
    // 没跳转:当前会话还是 s1
    expect(shell.calls.some((c) => c.cmd === "session_open" && c.args?.id === "s2")).toBe(false);
  });
});

describe("D5 首启向导", () => {
  it("桌面壳模型清单为空:自动打开设置页;关闭后不再纠缠", async () => {
    const shell = stubShell({ models: [] });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "设置" })).toBeTruthy();
    const opens = shell.count("models_list");
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByText("开始一个任务")).toBeTruthy();
    await act(() => Promise.resolve());
    // 不循环:关闭后不再自动弹回,也不反复探测
    expect(screen.queryByRole("heading", { name: "设置" })).toBeNull();
    expect(shell.count("models_list")).toBe(opens);
  });

  it("已有模型:不自动打开设置页", async () => {
    stubShell({ models: [{ name: "m", default: true }] });
    render(<App />);
    await act(() => Promise.resolve());
    expect(screen.queryByRole("heading", { name: "设置" })).toBeNull();
  });
});

describe("D8 列表增量与意图跳转", () => {
  it("session-event 携未知 id:重拉全表", async () => {
    const shell = stubShell({ sessions: [sess({ id: "s1" })] });
    render(<App />);
    await waitFor(() => expect(shell.count("sessions_list")).toBeGreaterThanOrEqual(1));
    const before = shell.count("sessions_list");
    act(() => shell.emit("session-event", { type: "session-status", id: "ghost", title: "新会话", status: "running" }));
    await waitFor(() => expect(shell.count("sessions_list")).toBe(before + 1));
  });

  it("壳意图指向本地快照没有的会话:先重拉再选中,chat kind 切 chat 空间", async () => {
    const shell = stubShell({
      sessions: [sess({ id: "s1" }), sess({ id: "c1", title: "闲聊会话", kind: "chat" })],
      intent: "open-session:c1",
    });
    render(<App />);
    await waitFor(() =>
      expect(shell.calls.some((c) => c.cmd === "session_open" && c.args?.id === "c1")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "本地会话" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("在此项目新建任务(侧栏组头 → 新建视图预填目录)", () => {
  it("点组头 + 打开新建视图,项目目录预填", async () => {
    const shell = stubShell({ sessions: [sess({ id: "s1", workdir: "/proj/alpha" })] });
    render(<App />);
    await waitFor(() => expect(shell.count("sessions_list")).toBeGreaterThanOrEqual(1));
    await userEvent.click(await screen.findByRole("button", { name: "在此项目新建任务" }));
    // 目录输入框收进「最近目录」下拉(卡头句式触发器),取值前先展开
    await userEvent.click(await screen.findByRole("button", { name: "最近目录" }));
    const dirInput = await screen.findByRole("textbox", { name: "项目目录" });
    expect((dirInput as HTMLInputElement).value).toBe("/proj/alpha");
  });
});

describe("H9 意图消费", () => {
  it("open-session / open-settings 事件送达即消费壳侧意图副本", async () => {
    const shell = stubShell({ sessions: [sess({ id: "s1" })] });
    render(<App />);
    await waitFor(() => expect(shell.count("take_ui_intent")).toBe(1)); // 启动补取

    act(() => shell.emit("open-session", "s1"));
    await waitFor(() => expect(shell.count("take_ui_intent")).toBe(2));

    act(() => shell.emit("open-settings", undefined));
    await waitFor(() => expect(shell.count("take_ui_intent")).toBe(3));
  });
});

describe("壳级提示(浏览器工具装载)", () => {
  it("browser-mcp-reloaded 出成功提示并自动消失;超时事件是警示且留到手动关闭", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const shell = stubShell();
      render(<App />);

      act(() => shell.emit("browser-mcp-reloaded", undefined));
      expect(await screen.findByText("浏览器工具已装载,引擎已按新配置重连")).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(6100);
      });
      expect(screen.queryByText("浏览器工具已装载,引擎已按新配置重连")).toBeNull();

      act(() => shell.emit("browser-mcp-refresh-timeout", undefined));
      const warn = await screen.findByText(/浏览器工具尚未装载/);
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.getByText(/浏览器工具尚未装载/)).toBe(warn); // 警示不自灭
    } finally {
      vi.useRealTimers();
    }
  });

  it("同一条重复推送只留最新一份,不叠成两条", async () => {
    const shell = stubShell();
    render(<App />);
    act(() => shell.emit("browser-mcp-refresh-timeout", undefined));
    act(() => shell.emit("browser-mcp-refresh-timeout", undefined));
    expect((await screen.findAllByText(/浏览器工具尚未装载/)).length).toBe(1);
  });
});
