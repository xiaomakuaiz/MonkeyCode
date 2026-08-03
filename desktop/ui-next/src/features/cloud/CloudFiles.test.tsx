// 云端文件页:控制流列目录(注入假控制流)、目录导航、上传入口条件。
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CloudControl } from "@/lib/cloud/control";
import { CloudFiles, fmtSize } from "./CloudFiles";

function fakeControl(): { ctl: CloudControl; calls: { kind: string; payload?: Record<string, unknown> }[] } {
  const calls: { kind: string; payload?: Record<string, unknown> }[] = [];
  const byDir: Record<string, unknown[]> = {
    "": [
      { name: "src", path: "src", entry_mode: 4 },
      { name: "README.md", path: "README.md", entry_mode: 1, size: 2048 },
      { name: ".git", path: ".git", entry_mode: 4 }, // 应被过滤
    ],
    src: [{ name: "main.ts", path: "src/main.ts", entry_mode: 1, size: 10 }],
  };
  const ctl: CloudControl = {
    call<T>(kind: string, payload?: Record<string, unknown>): Promise<T> {
      calls.push({ kind, payload });
      const dir = (payload?.path as string) ?? "";
      return Promise.resolve({ files: byDir[dir] ?? [] } as T);
    },
    close: vi.fn(),
  };
  return { ctl, calls };
}

describe("CloudFiles", () => {
  it("列目录:目录在前排序、.git 过滤、点目录下钻、返回上级", async () => {
    const { ctl, calls } = fakeControl();
    render(<CloudFiles taskId="t1" vmId="vm1" makeControl={() => ctl} />);
    await screen.findByText("README.md");
    expect(screen.queryByText(".git")).toBeNull();
    expect(calls[0]).toMatchObject({ kind: "repo_file_list", payload: { path: "", glob_pattern: "*", include_hidden: true } });
    await userEvent.click(screen.getByText("src"));
    await screen.findByText("main.ts");
    expect(calls.at(-1)?.payload).toMatchObject({ path: "src" });
    await userEvent.click(screen.getByText("返回上级"));
    await screen.findByText("README.md");
  });

  it("无 vmId(VM 未就绪/已结束):无上传与下载入口", async () => {
    const { ctl } = fakeControl();
    render(<CloudFiles taskId="t1" makeControl={() => ctl} />);
    await screen.findByText("README.md");
    expect(screen.queryByText("上传文件")).toBeNull();
    expect(screen.queryByText("下载")).toBeNull();
  });

  it("有 vmId:上传入口在;列表失败外显", async () => {
    const bad: CloudControl = {
      call: () => Promise.reject(new Error("环境离线")),
      close: vi.fn(),
    };
    render(<CloudFiles taskId="t1" vmId="vm1" makeControl={() => bad} />);
    expect((await screen.findByRole("alert")).textContent).toContain("环境离线");
    expect(screen.getByText("上传文件")).toBeTruthy();
  });

  it("fmtSize 可读格式", () => {
    expect(fmtSize(undefined)).toBe("");
    expect(fmtSize(512)).toBe("512 B");
    expect(fmtSize(2048)).toBe("2.0 KB");
    expect(fmtSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
