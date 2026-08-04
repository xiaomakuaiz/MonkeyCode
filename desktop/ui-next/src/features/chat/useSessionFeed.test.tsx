// 会话数据面 hook 的独立契约测试(此前只被 ChatView 测试间接覆盖)。
// 钉住的契约:①监听先于命令;②session_open 用 cursor、session_history 用
// next_cursor(真实壳形状不同名,曾因共用类型翻页坏死);③失败外显可重试;
// ④ensureLoaded 按字节偏移补页,失败/到头不空转。
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
