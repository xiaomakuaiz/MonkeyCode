// 云端任务详情冒烟:结束态 rounds 回放、启动态时间线(假壳 invoke;
// 协议状态机的行为契约在 lib/cloud/stream.test.ts,这里只验编排与渲染)。
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { b64encode } from "@/lib/protocol/codec";
import { CloudTaskView } from "./CloudTaskView";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function stubShell(invoke: Invoke) {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke },
    event: { listen: () => Promise.resolve(() => {}) },
  };
}

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe("CloudTaskView", () => {
  it("结束态:mc_task_rounds 回放经归约渲染,只读提示,无 composer", async () => {
    stubShell((cmd) => {
      switch (cmd) {
        case "mc_task_info":
          return Promise.resolve({ id: "t1", status: "finished", title: "完结任务" });
        case "mc_task_rounds":
          return Promise.resolve({
            frames: [
              { type: "user-input", seq: 1, timestamp: 1000, data: { content: b64encode("部署到测试环境") } },
              { type: "task-ended", seq: 2, timestamp: 2000 },
            ],
            next_cursor: "",
            has_more: false,
          });
        default:
          return Promise.resolve({});
      }
    });
    render(<CloudTaskView task={{ id: "t1", title: "完结任务", status: "finished" }} />);
    await screen.findByText("部署到测试环境"); // 回放的用户消息(content 解 base64)
    expect(screen.getByText("— 本轮结束 —")).toBeTruthy();
    expect(screen.getByText(/只读回放/)).toBeTruthy();
    expect(screen.queryByLabelText("消息输入")).toBeNull(); // 结束态无 composer
    expect(screen.queryByText("终止任务")).toBeNull(); // 结束态无停止按钮
  });

  it("启动态:整屏时间线,composer 禁用,停止按钮在", async () => {
    stubShell((cmd) => {
      switch (cmd) {
        case "mc_task_info":
          return Promise.resolve({
            id: "t2",
            status: "pending",
            virtualmachine: { id: "", status: "creating", conditions: [{ type: "ImagePulled", status: 1, progress: 30 }] },
          });
        default:
          return Promise.resolve({});
      }
    });
    render(<CloudTaskView task={{ id: "t2", title: "新任务", status: "pending" }} />);
    await screen.findByText("正在拉取系统镜像…");
    expect(screen.getByText("30%")).toBeTruthy();
    const composer = screen.getByLabelText<HTMLTextAreaElement>("消息输入");
    expect(composer.disabled).toBe(true);
    expect(screen.getByText("终止任务")).toBeTruthy();
    expect(screen.getByText("排队中")).toBeTruthy(); // 状态徽标
  });

  it("加载更早:有游标才出现,点击往前翻一轮并前插", async () => {
    let roundsCalls = 0;
    stubShell((cmd) => {
      switch (cmd) {
        case "mc_task_info":
          return Promise.resolve({ id: "t3", status: "finished" });
        case "mc_task_rounds":
          roundsCalls += 1;
          return roundsCalls === 1
            ? Promise.resolve({
                frames: [{ type: "user-input", seq: 10, data: { content: b64encode("第二轮提问") } }],
                next_cursor: "c-early",
                has_more: true,
              })
            : Promise.resolve({
                frames: [{ type: "user-input", seq: 1, data: { content: b64encode("第一轮提问") } }],
                next_cursor: "",
                has_more: false,
              });
        default:
          return Promise.resolve({});
      }
    });
    render(<CloudTaskView task={{ id: "t3", status: "finished" }} />);
    await screen.findByText("第二轮提问");
    const btn = await screen.findByText("加载更早");
    btn.click();
    await screen.findByText("第一轮提问");
    // 前插:更早的一轮在前(按 LogList 的 data-user-seq 结构锚,不断样式类)
    const seqs = [...document.querySelectorAll("[data-user-seq]")].map((el) => el.getAttribute("data-user-seq"));
    expect(seqs).toEqual(["1", "10"]);
  });
});
