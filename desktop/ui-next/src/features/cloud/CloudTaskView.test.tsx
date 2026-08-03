// 云端任务详情冒烟:结束态 rounds 回放、启动态时间线、审批答复经 WS 上行
// (假壳 invoke;协议状态机的行为契约在 lib/cloud/stream.test.ts,这里只验
// 编排与渲染)。
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { b64decode, b64encode } from "@/lib/protocol/codec";
import { CloudTaskView } from "./CloudTaskView";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function stubShell(invoke: Invoke) {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke },
    event: { listen: () => Promise.resolve(() => {}) },
  };
}

/** 带事件管道的假壳:记录 ws-msg/ws-closed 监听,测试可向下行推帧。 */
function stubShellWs(invoke: Invoke) {
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke },
    event: {
      listen: (name: string, cb: (e: { payload: unknown }) => void) => {
        listeners.set(name, cb);
        return Promise.resolve(() => listeners.delete(name));
      },
    },
  };
  return listeners;
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

  it("运行中:审批答复经 stream WS 上行(帧形状 {type, data: b64(JSON)}),不走本地 IPC", async () => {
    const wsSends: { pipe?: unknown; text?: unknown }[] = [];
    const sessionSends: unknown[] = [];
    let wsPipe = "";
    const listeners = stubShellWs((cmd, args) => {
      switch (cmd) {
        case "mc_task_info":
          return Promise.resolve({ id: "t4", status: "processing", title: "跑着的任务" });
        case "cloud_ws_open":
          wsPipe = String(args?.pipe ?? "");
          return Promise.resolve({});
        case "cloud_ws_send":
          wsSends.push(args ?? {});
          return Promise.resolve({});
        case "session_send":
          sessionSends.push(args);
          return Promise.resolve({});
        default:
          return Promise.resolve({});
      }
    });
    render(<CloudTaskView task={{ id: "t4", status: "processing" }} />);
    await waitFor(() => expect(wsPipe).not.toBe("")); // attach 已拨通
    // 下行一张待答复审批卡(与本地 Frame 同构,喂同一条归约链)
    listeners.get(`ws-msg:${wsPipe}`)?.({
      payload: JSON.stringify({ type: "permission-req", seq: 1, data: { id: "p1", title: "npm test", tool: "Bash" } }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "允许" }));

    await waitFor(() => expect(wsSends).toHaveLength(1));
    const frame = JSON.parse(String(wsSends[0]?.text)) as { type: string; data: string; timestamp: number };
    expect(frame.type).toBe("permission-resp");
    expect(JSON.parse(b64decode(frame.data))).toEqual({ id: "p1", approved: true, remember: false, persist: false });
    expect(typeof frame.timestamp).toBe("number");
    expect(sessionSends).toEqual([]); // 云端任务 id 上绝不能落到 session_send
    expect(await screen.findByText("已允许")).toBeTruthy(); // 送达后乐观置态保持
  });

  it("运行中:WS 发送失败时审批卡回滚可重点(不乐观假装已决)", async () => {
    let wsPipe = "";
    const listeners = stubShellWs((cmd, args) => {
      switch (cmd) {
        case "mc_task_info":
          return Promise.resolve({ id: "t5", status: "processing" });
        case "cloud_ws_open":
          wsPipe = String(args?.pipe ?? "");
          return Promise.resolve({});
        case "cloud_ws_send":
          return Promise.reject(new Error("pipe dead"));
        default:
          return Promise.resolve({});
      }
    });
    render(<CloudTaskView task={{ id: "t5", status: "processing" }} />);
    await waitFor(() => expect(wsPipe).not.toBe(""));
    listeners.get(`ws-msg:${wsPipe}`)?.({
      payload: JSON.stringify({ type: "permission-req", seq: 1, data: { id: "p1", title: "npm test", tool: "Bash" } }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "允许" }));
    // 未送达:乐观徽标回滚,按钮恢复可点
    await waitFor(() => expect(screen.getByRole("button", { name: "允许" })).toBeTruthy());
    expect(screen.queryByText("已允许")).toBeNull();
  });
});
