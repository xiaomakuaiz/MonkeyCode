import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { AboutSection } from "./AboutSection";

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

function stubShell({ failInstall }: { failInstall?: string } = {}) {
  const calls: string[] = [];
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string) => {
        calls.push(cmd);
        if (cmd === "host_info") return Promise.resolve({ version: "1.0", engine_version: "0.9" });
        if (cmd === "update_check") return Promise.resolve({ available: true, current: "1.0", latest: "1.1" });
        if (cmd === "update_install" && failInstall) return Promise.reject(new Error(failInstall));
        if (cmd === "update_install") return new Promise(() => {}); // 成功:壳自行重启,不返回
        return Promise.resolve(null);
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };
  return { calls };
}

describe("关于页更新(H5)", () => {
  it("安装失败:复位忙态、外显失败文案,按钮可重试", async () => {
    stubShell({ failInstall: "签名校验失败" });
    render(<AboutSection />);
    await userEvent.click(screen.getByRole("button", { name: "检查更新" }));
    const install = await screen.findByRole("button", { name: "下载更新" });

    await userEvent.click(install);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("更新失败:签名校验失败"));
    const again = screen.getByRole("button", { name: "下载更新" }); // 忙态已复位,不再是"更新中…"
    expect((again as HTMLButtonElement).disabled).toBe(false);
  });

  it("安装成功路径:壳自行重启,按钮停在更新中", async () => {
    stubShell();
    render(<AboutSection />);
    await userEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await userEvent.click(await screen.findByRole("button", { name: "下载更新" }));
    const busy = screen.getByRole("button", { name: /更新中/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("隐藏排障入口(连点版本号解锁)", () => {
  it("常态只有「检查更新」:导出日志/打开扩展目录已撤,两个目录入口不出现", async () => {
    stubShell();
    render(<AboutSection />);
    await screen.findByText(/应用 1\.0/);
    expect(screen.queryByRole("button", { name: "导出日志" })).toBeNull();
    expect(screen.queryByRole("button", { name: "打开扩展目录" })).toBeNull();
    expect(screen.queryByRole("button", { name: "打开程序目录" })).toBeNull();
    expect(screen.queryByRole("button", { name: "打开存储目录" })).toBeNull();
  });

  it("连点版本号 5 次:两个入口现身,分别走 open_app_dir / open_log_dir", async () => {
    const { calls } = stubShell();
    render(<AboutSection />);
    const version = await screen.findByRole("button", { name: /应用 1\.0/ });
    for (let i = 0; i < 4; i++) await userEvent.click(version);
    expect(screen.queryByRole("button", { name: "打开程序目录" })).toBeNull(); // 差一次不解锁
    await userEvent.click(version);

    await userEvent.click(screen.getByRole("button", { name: "打开程序目录" }));
    await userEvent.click(screen.getByRole("button", { name: "打开存储目录" }));
    await waitFor(() => expect(calls).toContain("open_app_dir"));
    expect(calls).toContain("open_log_dir");
  });
});
