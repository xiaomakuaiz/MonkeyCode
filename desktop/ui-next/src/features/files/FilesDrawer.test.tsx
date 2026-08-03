import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilesDrawer } from "./FilesDrawer";

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  localStorage.clear();
  vi.unstubAllGlobals();
});

interface CallRecord {
  kind: string;
  payload: Record<string, unknown>;
}

/** 壳桩:session_call 按 kind 分派(与 driver/mod.rs::session_call 同构)。 */
function stubShell(opts: { list?: Record<string, unknown[]>; changes?: unknown; content?: string; diff?: string }) {
  const calls: CallRecord[] = [];
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        if (cmd !== "session_call") return Promise.resolve(null);
        const kind = String(args?.kind);
        const payload = (args?.payload ?? {}) as Record<string, unknown>;
        calls.push({ kind, payload });
        if (kind === "repo_file_list") return Promise.resolve({ result: opts.list?.[String(payload.path)] ?? [] });
        if (kind === "repo_file_changes") return Promise.resolve(opts.changes ?? { result: [], is_git_repo: true });
        if (kind === "repo_read_file") return Promise.resolve({ result: { content: opts.content ?? "" } });
        if (kind === "repo_file_diff") return Promise.resolve({ result: { diff: opts.diff ?? "" } });
        return Promise.resolve({ result: null });
      },
    },
  };
  return calls;
}

const entry = (name: string, path: string, isDir = false) => ({ name, path, is_dir: isDir, size: 12 });
const flush = () => act(() => Promise.resolve());

describe("文件抽屉", () => {
  it("树懒加载:根目录挂载即拉,子目录点开才拉,收起再展开走缓存", async () => {
    const calls = stubShell({
      list: {
        "": [entry("src", "src", true), entry("README.md", "README.md")],
        src: [entry("index.ts", "src/index.ts")],
      },
    });
    render(<FilesDrawer sessionId="s1" onClose={() => {}} />);

    expect(await screen.findByRole("button", { name: /README\.md/ })).toBeTruthy();
    const listCalls = () => calls.filter((c) => c.kind === "repo_file_list").map((c) => c.payload.path);
    expect(listCalls()).toEqual([""]);

    await userEvent.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: /index\.ts/ })).toBeTruthy();
    expect(listCalls()).toEqual(["", "src"]);

    // 收起再展开:走缓存,不再发请求
    await userEvent.click(screen.getByRole("button", { name: "src" }));
    expect(screen.queryByRole("button", { name: /index\.ts/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "src" }));
    expect(screen.getByRole("button", { name: /index\.ts/ })).toBeTruthy();
    expect(listCalls()).toEqual(["", "src"]);
  });

  it("文件点击 → 读取内容并在预览窗格展示(带行号)", async () => {
    stubShell({ list: { "": [entry("note.txt", "note.txt")] }, content: "hello world" });
    render(<FilesDrawer sessionId="s1" onClose={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: /note\.txt/ }));
    expect(await screen.findByText("hello world")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy(); // 行号
  });

  it("tab 切到改动(带计数 badge),点改动行出 diff 预览", async () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " ctx line",
      "-old line",
      "+new line",
      "",
    ].join("\n");
    stubShell({
      list: { "": [] },
      changes: { result: [{ path: "src/a.ts", status: "M" }], is_git_repo: true },
      diff,
    });
    render(<FilesDrawer sessionId="s1" onClose={() => {}} />);

    const tab = await screen.findByRole("tab", { name: /改动/ });
    expect(tab.textContent).toContain("1"); // 计数 badge
    await userEvent.click(tab);

    const row = await screen.findByRole("button", { name: /a\.ts/ });
    expect(row.textContent).toContain("修改"); // 状态徽标
    await userEvent.click(row);

    expect(await screen.findByText("@@ -1,2 +1,2 @@")).toBeTruthy();
    expect(screen.getByText("new line")).toBeTruthy();
    expect(screen.getByText("old line")).toBeTruthy();
  });

  it("宽度:localStorage 存量生效;拖拽调宽松手落盘(mc.drawerWidth)", async () => {
    localStorage.setItem("mc.drawerWidth", "777");
    stubShell({ list: { "": [] } });
    render(<FilesDrawer sessionId="s1" onClose={() => {}} />);
    await flush();

    const panel = screen.getByRole("region", { name: "会话文件" });
    expect(panel.style.width).toBe("777px");

    fireEvent.mouseDown(screen.getByTitle("拖动调整宽度"));
    fireEvent.mouseMove(window, { clientX: 300 });
    fireEvent.mouseUp(window);

    const expected = window.innerWidth - 300;
    expect(panel.style.width).toBe(`${expected}px`);
    expect(localStorage.getItem("mc.drawerWidth")).toBe(String(expected));
  });

  it("Esc(window capture):预览开着先关预览,再一次才关抽屉", async () => {
    const onClose = vi.fn();
    stubShell({ list: { "": [entry("a.txt", "a.txt")] }, content: "hello" });
    render(<FilesDrawer sessionId="s1" onClose={onClose} />);

    await userEvent.click(await screen.findByRole("button", { name: /a\.txt/ }));
    await screen.findByText("hello");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("hello")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 消费后截断传播(H1):window 上后续监听不再收到这一下按键", async () => {
    const onClose = vi.fn();
    stubShell({ list: { "": [] } });
    render(<FilesDrawer sessionId="s1" onClose={onClose} />);
    await flush();

    // 模拟审批热键(app/shortcuts.ts 挂 window bubble):抽屉消费 Esc 后
    // 绝不能漏到这里——esc = deny 不可逆,同一下按键不许双消费
    const leaked = vi.fn();
    window.addEventListener("keydown", leaked);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(leaked).not.toHaveBeenCalled();

    // 非 Esc 按键不截断,照常传播
    fireEvent.keyDown(window, { key: "a" });
    expect(leaked).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", leaked);
  });

  it("Windows 壳(H3):scrim/面板从自绘标题栏下缘起(top-9),不遮三键与拖拽区", async () => {
    vi.stubGlobal("navigator", { ...window.navigator, userAgent: "Windows NT 10.0" });
    stubShell({ list: { "": [] } });
    const { container } = render(<FilesDrawer sessionId="s1" onClose={() => {}} />);
    await flush();
    const scrim = container.querySelector(".z-30");
    const panel = screen.getByRole("region", { name: "会话文件" });
    expect(scrim?.className).toContain("top-9");
    expect(scrim?.className).not.toContain("inset-0");
    expect(panel.className).toContain("top-9");
  });

  it("非 Windows 壳:抽屉照旧贴视口顶(top-0)", async () => {
    stubShell({ list: { "": [] } });
    const { container } = render(<FilesDrawer sessionId="s1" onClose={() => {}} />);
    await flush();
    expect(container.querySelector(".z-30")?.className).toContain("top-0");
    expect(screen.getByRole("region", { name: "会话文件" }).className).toContain("top-0");
  });

  it("非 git 工作区:改动 tab 不渲染,只留文件浏览", async () => {
    stubShell({ list: { "": [] }, changes: { result: [], is_git_repo: false } });
    render(<FilesDrawer sessionId="s1" onClose={() => {}} />);
    await flush();
    expect(screen.queryByRole("tab", { name: /改动/ })).toBeNull();
    expect(screen.getByRole("tab", { name: "文件" })).toBeTruthy();
  });

  it("refreshToken 自增(轮次结束)重拉改动列表", async () => {
    const calls = stubShell({ list: { "": [] } });
    const { rerender } = render(<FilesDrawer sessionId="s1" onClose={() => {}} refreshToken={0} />);
    await flush();
    expect(calls.filter((c) => c.kind === "repo_file_changes")).toHaveLength(1);

    rerender(<FilesDrawer sessionId="s1" onClose={() => {}} refreshToken={1} />);
    await flush();
    expect(calls.filter((c) => c.kind === "repo_file_changes")).toHaveLength(2);
  });
});
