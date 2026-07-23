import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { NewTaskView } from "./newtask";
import { Sidebar } from "./sidebar";

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { userAgent: "vitest" });
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: vi.fn(),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("侧栏新建任务入口", () => {
  it("云端任务标题栏提供新建按钮", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        sessions={[]}
        currentId={null}
        attention={new Set()}
        sessionActive={false}
        connected={false}
        status="未连接"
        mcConnection={{ phase: "connected", host: "monkeycode-ai.com" }}
        cloudTasks={[]}
        onConnectCloud={() => {}}
        onRefreshCloud={() => {}}
        onNewCloudTask={() => {}}
        onOpenCloudTask={() => {}}
        onSelect={() => {}}
        onNewTask={() => {}}
        onOpenSettings={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    );

    expect(html).toContain('title="新建云端任务"');
  });

  it("云端入口的预填会直接打开云端模式", () => {
    const html = renderToStaticMarkup(
      <NewTaskView
        models={[]}
        lastDir=""
        recentDirs={[]}
        prefill={{ mode: "cloud" }}
        cloudReady={false}
        onCreated={() => {}}
        onCloudCreated={() => {}}
      />,
    );

    expect(html).toContain("不关联仓库(快速开始)");
    expect(html).toContain("云端任务需要先连接 MonkeyCode");
    expect(html).toContain('title="请先连接 MonkeyCode 后再创建云端任务"');
    expect(html).toContain("请先连接");
  });
});
