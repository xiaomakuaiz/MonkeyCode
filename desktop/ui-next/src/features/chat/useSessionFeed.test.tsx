// 会话数据面 hook 的独立契约测试(此前只被 ChatView 测试间接覆盖)。
// 钉住的契约:①监听先于命令;②session_open 用 cursor、session_history 用
// next_cursor(真实壳形状不同名,曾因共用类型翻页坏死);③失败外显可重试;
// ④ensureLoaded 按字节偏移补页,失败/到头不空转;⑤实时帧抢在窗口之前落地
// 也不丢历史;⑥监听注册未落地就卸载,退订仍要执行;⑦打开失败必须外显。
import { renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { b64encode } from "@/lib/protocol/codec";
import { useSessionFeed } from "./useSessionFeed";

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

interface Op {
  op: string;
  cmd?: string;
  args?: Record<string, unknown>;
}

function userFrame(seq: number, text: string) {
  return { type: "user-input", data: { content: b64encode(text) }, timestamp: seq, seq };
}

/** pages:session_history 按调用次序吐出的页(或 Error 表示该次失败)。 */
function stubShell(
  pages: Array<{ frames?: unknown[]; next_cursor: number; has_more: boolean } | Error>,
  open: { cursor: number; has_more: boolean } = { cursor: 100, has_more: true },
) {
  const ops: Op[] = [];
  let historyCalls = 0;
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        ops.push({ op: "invoke", cmd, args });
        if (cmd === "session_open") {
          return Promise.resolve({ frames: [userFrame(9, "最新问题")], ...open });
        }
        if (cmd === "session_history") {
          const page = pages[Math.min(historyCalls, pages.length - 1)];
          historyCalls += 1;
          if (page instanceof Error) return Promise.reject(page);
          return Promise.resolve({ frames: [], ...page });
        }
        return Promise.resolve(null);
      },
    },
    event: {
      listen: (name: string) => {
        ops.push({ op: "listen", cmd: name });
        return Promise.resolve(() => {});
      },
    },
  };
  return { ops };
}

describe("useSessionFeed:生命周期与翻页游标", () => {
  it("铁律:frames/conn 监听注册先于 session_open;窗口游标入位", async () => {
    const { ops } = stubShell([]);
    const { result } = renderHook(() => useSessionFeed("s1"));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    const openAt = ops.findIndex((o) => o.op === "invoke" && o.cmd === "session_open");
    expect(ops.findIndex((o) => o.op === "listen" && o.cmd === "frames:s1")).toBeLessThan(openAt);
    expect(ops.findIndex((o) => o.op === "listen" && o.cmd === "conn-status:s1")).toBeLessThan(openAt);
  });

  it("loadEarlier:游标取 next_cursor(非 cursor),下一页从新游标翻", async () => {
    const { ops } = stubShell([
      { frames: [userFrame(5, "第二页")], next_cursor: 40, has_more: true },
      { frames: [userFrame(2, "第三页")], next_cursor: 0, has_more: false },
    ]);
    const { result } = renderHook(() => useSessionFeed("s1"));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(() => result.current.loadEarlier());
    let calls = ops.filter((o) => o.cmd === "session_history");
    expect(calls[0]!.args).toEqual({ id: "s1", cursor: 100, limit: 3 });

    await act(() => result.current.loadEarlier());
    calls = ops.filter((o) => o.cmd === "session_history");
    expect(calls[1]!.args).toEqual({ id: "s1", cursor: 40, limit: 3 });
    expect(result.current.hasMore).toBe(false);
    expect(result.current.state.items.some((it) => it.kind === "user" && it.text === "第三页")).toBe(true);
  });

  it("loadEarlier 的 beforeApply 在前插**写入前**同步回调(视图靠它记滚动锚点)", async () => {
    stubShell([{ frames: [userFrame(5, "更早的问题")], next_cursor: 0, has_more: false }]);
    const { result } = renderHook(() => useSessionFeed("s1"));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    let itemsWhenCalled = -1;
    await act(() =>
      result.current.loadEarlier(() => {
        itemsWhenCalled = result.current.state.items.length;
      }),
    );
    // 回调发生时窗口那一条还是唯一一条:锚点量的是"前插之前"的版面
    expect(itemsWhenCalled).toBe(1);
    expect(result.current.state.items).toHaveLength(2);
  });

  it("loadEarlier 失败:earlierError 外显,重试成功后清空", async () => {
    stubShell([
      new Error("io 断了"),
      { frames: [userFrame(5, "补上的页")], next_cursor: 0, has_more: false },
    ]);
    const { result } = renderHook(() => useSessionFeed("s1"));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(() => result.current.loadEarlier());
    expect(result.current.earlierError).toBe("io 断了");

    await act(() => result.current.loadEarlier());
    expect(result.current.earlierError).toBeNull();
    expect(result.current.state.items.some((it) => it.kind === "user" && it.text === "补上的页")).toBe(true);
  });
});

describe("useSessionFeed:窗口与实时帧的先后、监听生命周期、打开失败", () => {
  /** 手动放行 session_open 的桩:回放窗口与实时帧的先后可控。 */
  function gatedShell() {
    const listeners = new Map<string, (e: { payload: unknown }) => void>();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: {
        invoke: (cmd: string) => {
          if (cmd === "session_open") {
            return gate.then(() => ({
              frames: [userFrame(1, "很久以前的问题"), userFrame(2, "窗口里的第二条")],
              cursor: 100,
              has_more: true,
            }));
          }
          return Promise.resolve(null);
        },
      },
      event: {
        listen: (name: string, cb: (e: { payload: unknown }) => void) => {
          listeners.set(name, cb);
          return Promise.resolve(() => listeners.delete(name));
        },
      },
    };
    return { listeners, release: () => release() };
  }

  it("实时帧抢在回放窗口之前落地:历史仍在(按前插归约,不被 seq 水位吃掉)", async () => {
    const { listeners, release } = gatedShell();
    const { result } = renderHook(() => useSessionFeed("s1"));
    // 铁律「监听先于命令」的另一面:壳在 session_open 处理中就同步推首批实时帧,
    // 它先于返回值到达是常态。实时 seq 严格高于窗口——若窗口仍走 reduceBatch,
    // 整份历史会被 seq 去重水位静默丢光(打开会话只剩最新一两条)
    await waitFor(() => expect(listeners.has("frames:s1")).toBe(true));
    act(() => {
      listeners.get("frames:s1")!({ payload: [userFrame(9, "刚发生的问题")] });
    });
    await waitFor(() => expect(result.current.state.items).toHaveLength(1));

    act(() => release());
    await waitFor(() => expect(result.current.historyLoaded).toBe(true));
    expect(
      result.current.state.items.filter((it) => it.kind === "user").map((it) => it.text),
    ).toEqual(["很久以前的问题", "窗口里的第二条", "刚发生的问题"]);
  });

  it("historyLoaded:窗口落地才置真(composer 的排队补投闸门等它)", async () => {
    const { release } = gatedShell();
    const { result } = renderHook(() => useSessionFeed("s1"));
    await waitFor(() => expect(result.current.state).toBeTruthy());
    expect(result.current.historyLoaded).toBe(false);
    act(() => release());
    await waitFor(() => expect(result.current.historyLoaded).toBe(true));
  });

  it("卸载早于监听注册落地:退订照样执行(此前 cleanup 关的是空占位,监听永久泄漏)", async () => {
    const offs: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: () => Promise.resolve(null) },
      event: {
        listen: (name: string) =>
          gate.then(() => () => {
            offs.push(name);
          }),
      },
    };
    const { unmount } = renderHook(() => useSessionFeed("s1"));
    unmount(); // 一次 IPC 往返之内切走/卸载:注册还在途中
    release();
    await waitFor(() => expect([...offs].sort()).toEqual(["conn-status:s1", "frames:s1"]));
  });

  it("session_open 失败:openError 外显(壳只在成功路径 emit conn-status,不显就是空会话)", async () => {
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: {
        invoke: (cmd: string) =>
          cmd === "session_open" ? Promise.reject(new Error("引擎没起来")) : Promise.resolve(null),
      },
      event: { listen: () => Promise.resolve(() => {}) },
    };
    const { result } = renderHook(() => useSessionFeed("s1"));
    // afterEngineReady 退避重试耗尽后才落定
    await waitFor(() => expect(result.current.openError).toBe("引擎没起来"), { timeout: 3000 });
    expect(result.current.historyLoaded).toBe(false);
    expect(result.current.conn).toBeNull();
  });
});

describe("useSessionFeed:ensureLoaded 按偏移补页", () => {
  it("连续翻页直到 cursor ≤ offset,不多翻", async () => {
    const { ops } = stubShell([
      { next_cursor: 60, has_more: true },
      { next_cursor: 30, has_more: true },
      { next_cursor: 10, has_more: true },
    ]);
    const { result } = renderHook(() => useSessionFeed("s1"));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(() => result.current.ensureLoaded(30));
    // 100→60→30,到 30(≤ offset)即停:恰好两次
    expect(ops.filter((o) => o.cmd === "session_history").length).toBe(2);
  });

  it("翻页失败游标不前进:立即停,不空转", async () => {
    const { ops } = stubShell([new Error("坏了")]);
    const { result } = renderHook(() => useSessionFeed("s1"));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(() => result.current.ensureLoaded(0));
    expect(ops.filter((o) => o.cmd === "session_history").length).toBe(1);
    expect(result.current.earlierError).toBe("坏了");
  });

  it("has_more=false 后不再发起翻页", async () => {
    const { ops } = stubShell([{ next_cursor: 50, has_more: false }]);
    const { result } = renderHook(() => useSessionFeed("s1"));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(() => result.current.ensureLoaded(0));
    expect(ops.filter((o) => o.cmd === "session_history").length).toBe(1);
  });
});
