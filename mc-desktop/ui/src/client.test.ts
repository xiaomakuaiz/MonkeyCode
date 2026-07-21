// connectCloudTask 重连状态机单测:mock 壳 IPC(invoke/listen)驱动管道生命周期。
// 覆盖用户实测炸过的场景:云端对"当前轮已结束"的 attach 直接关连接,
// 客户端不能当断线无限重连(「云端连接断开,2 秒后自动重连…」死循环)。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- 假 Tauri 壳:cloud_ws_open 按脚本决定成败;事件按 pipe 精确投递 ----
interface PipeScript {
  /** 每次 open 的行为队列:true=成功建管道,false=拒绝(拨号失败) */
  opens: boolean[];
}
const listeners = new Map<string, (e: { payload: unknown }) => void>();
let script: PipeScript = { opens: [] };
let openCalls = 0;
let openPipes: string[] = []; // 成功建立的 pipe id(按序)
let sent: string[] = []; // 上行文本帧

function emit(name: string, payload: unknown) {
  listeners.get(name)?.({ payload });
}

/** 给第 n 条(默认最新)管道发下行帧 */
function pushFrame(f: Record<string, unknown>, pipeIdx = -1) {
  const pipe = openPipes.at(pipeIdx);
  emit(`ws-msg:${pipe}`, JSON.stringify(f));
}
/** 关闭第 n 条(默认最新)管道;info 模拟壳透传的服务端 Close 帧
 * (如 {code:1000} 正常关闭),缺省 null = 异常断开 */
function closePipe(pipeIdx = -1, info: { code?: number; reason?: string } | null = null) {
  const pipe = openPipes.at(pipeIdx);
  emit(`ws-closed:${pipe}`, info);
}

beforeEach(() => {
  listeners.clear();
  script = { opens: [] };
  openCalls = 0;
  openPipes = [];
  sent = [];
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).window = {
    __TAURI__: {
      core: {
        invoke: (cmd: string, args?: { pipe?: string; text?: string }) => {
          if (cmd === "cloud_ws_open") {
            const okOpen = script.opens[openCalls] ?? true;
            openCalls += 1;
            if (!okOpen) return Promise.reject(new Error("dial failed"));
            openPipes.push(args!.pipe!);
            return Promise.resolve(null);
          }
          if (cmd === "cloud_ws_send") {
            sent.push(args!.text!);
            return Promise.resolve(null);
          }
          if (cmd === "cloud_ws_close") return Promise.resolve(null);
          return Promise.reject(new Error("unexpected cmd " + cmd));
        },
      },
      event: {
        listen: (name: string, cb: (e: { payload: unknown }) => void) => {
          listeners.set(name, cb);
          return Promise.resolve(() => listeners.delete(name));
        },
      },
    },
  };
  // rAF:立即执行(帧批量上抛用)
  (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: () => void) => {
    cb();
    return 0;
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).window;
});

async function makeConn(mode: "attach" | "new", firstInput?: string) {
  const { connectCloudTask } = await import("./client");
  const events: string[] = [];
  const conn = connectCloudTask(
    "task-1",
    mode,
    {
      onFrames: (batch) => events.push("frames:" + batch.map((f) => f.type).join(",")),
      onStatus: (text) => events.push("status:" + text),
      onEnded: () => events.push("ended"),
      onIdle: () => events.push("idle"),
      onSendFailed: (text) => events.push("sendFailed:" + text),
      onReconnect: () => events.push("reconnect"),
    },
    firstInput,
  );
  await vi.advanceTimersByTimeAsync(0); // 让 openPipe 的 promise 链落定
  return { conn, events };
}

describe("connectCloudTask 重连状态机", () => {
  it("空闲关闭(连上后只有 cursor 就被关)→ onIdle,绝不重连", async () => {
    script.opens = [true];
    const { events } = await makeConn("attach");
    pushFrame({ type: "cursor", data: { cursor: "3", has_more: true } });
    closePipe();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContain("idle");
    expect(openCalls).toBe(1); // 没有任何重连
    expect(events.join()).not.toContain("自动重连");
  });

  it("轮结束(task-ended)后关闭 → 不重连,状态提示可继续对话", async () => {
    script.opens = [true];
    const { events } = await makeConn("attach");
    pushFrame({ type: "task-started", seq: 1 });
    pushFrame({ type: "task-ended", seq: 2 });
    closePipe();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContain("ended");
    expect(openCalls).toBe(1);
    expect(events.some((e) => e.includes("本轮已结束"))).toBe(true);
  });

  it("回放整轮业务帧后服务端正常关闭(1000)→ onIdle,绝不重连", async () => {
    // 用户实测死循环的变体:当前轮已结束但任务仍 processing,attach 回放
    // 历史帧(framesThisOpen>0)后云端正常关连接——不是断线
    script.opens = [true];
    const { events } = await makeConn("attach");
    pushFrame({ type: "task-started", seq: 1 });
    pushFrame({ type: "task-running", kind: "acp_event", seq: 2 });
    closePipe(-1, { code: 1000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContain("idle");
    expect(openCalls).toBe(1);
    expect(events.join()).not.toContain("自动重连");
  });

  it("task-ended 的 seq 低于回放水位(被去重)也要停机,不得重连", async () => {
    // 单调 seq 去重不能误杀停机信号:控制帧把水位顶高后 task-ended 后到
    script.opens = [true];
    const { events } = await makeConn("attach");
    pushFrame({ type: "task-started", seq: 10 });
    pushFrame({ type: "task-ended", seq: 5 }); // seq 低于水位,帧本身被去重
    closePipe();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContain("ended");
    expect(openCalls).toBe(1);
    expect(events.some((e) => e.includes("本轮已结束"))).toBe(true);
  });

  it("连续短命断流(无 Close 帧可识别)达上限 → 转 onIdle 兜底", async () => {
    // 兜底闸:即便服务端异常关闭不带原因码,也不能永远 2 秒循环
    script.opens = [true, true, true, true, true, true];
    const { events } = await makeConn("attach");
    for (let i = 0; i < 5; i++) {
      pushFrame({ type: "task-running", kind: "acp_event", seq: 1 }); // 重连后水位归零,seq=1 均有效
      closePipe();
      await vi.advanceTimersByTimeAsync(2100);
    }
    expect(openCalls).toBe(5); // 第 5 次断流后放弃,不再第 6 次
    expect(events).toContain("idle");
    expect(events.some((e) => e.includes("反复断开"))).toBe(true);
  });

  it("活跃流中途断开 → 按 2s 重连并回放归零(onReconnect)", async () => {
    script.opens = [true, true];
    const { events } = await makeConn("attach");
    pushFrame({ type: "task-started", seq: 1 });
    pushFrame({ type: "task-running", kind: "acp_event", seq: 2 });
    closePipe();
    expect(events.some((e) => e.includes("2 秒后自动重连"))).toBe(true);
    await vi.advanceTimersByTimeAsync(2100);
    expect(openCalls).toBe(2);
    expect(events).toContain("reconnect");
  });

  it("连续拨号失败 → 指数退避,5 次后放弃转 onIdle", async () => {
    script.opens = [false, false, false, false, false];
    const { events } = await makeConn("attach");
    // 退避:2s,4s,8s,16s;第 5 次失败后放弃
    await vi.advanceTimersByTimeAsync(2100); // fail#2
    await vi.advanceTimersByTimeAsync(4100); // fail#3
    await vi.advanceTimersByTimeAsync(8100); // fail#4
    await vi.advanceTimersByTimeAsync(16100); // fail#5 → 放弃
    await vi.advanceTimersByTimeAsync(120_000);
    expect(openCalls).toBe(5);
    expect(events).toContain("idle");
    expect(events.some((e) => e.includes("发送消息时会重试"))).toBe(true);
  });

  it("mode=new 拨号失败 → 首条输入经 onSendFailed 交还,不重试", async () => {
    script.opens = [false];
    const { events } = await makeConn("new", "你好云端");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContain("sendFailed:你好云端");
    expect(openCalls).toBe(1);
  });

  it("mode=new 已上行但零回显被关 → onSendFailed 兜底,不静默丢", async () => {
    script.opens = [true];
    const { events } = await makeConn("new", "排队内容");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.length).toBe(1); // user-input 已上行
    closePipe(); // 云端没回显任何帧就关(拒收)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContain("sendFailed:排队内容");
    expect(openCalls).toBe(1);
  });

  it("mode=new 有回显后中断 → 正常按断线重连(不误判拒收)", async () => {
    script.opens = [true, true];
    const { events } = await makeConn("new", "正常输入");
    await vi.advanceTimersByTimeAsync(0);
    pushFrame({ type: "user-input", seq: 1, data: "e30=" }); // 回显到达
    closePipe();
    await vi.advanceTimersByTimeAsync(2100);
    expect(events.join()).not.toContain("sendFailed");
    expect(openCalls).toBe(2);
  });
});
