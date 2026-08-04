// composer 状态机的独立契约测试(此前只被 Composer.test 间接覆盖):
// 切会话留档/恢复、排队单槽、失败不丢草稿、迟到回执的纪元守卫。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { b64encode } from "@/lib/protocol/codec";
import { resetStashForTests, stashGet } from "./stash";
import { useComposer } from "./useComposer";

function stubSend(impl: (cmd: string) => unknown) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        try {
          return Promise.resolve(impl(cmd));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    },
  };
  return calls;
}

beforeEach(() => {
  resetStashForTests();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe("useComposer:跨会话留档/恢复", () => {
  it("切会话留档草稿与排队,切回恢复;新会话是干净的", async () => {
    stubSend(() => null);
    const { result, rerender } = renderHook(({ id, running }) => useComposer(id, running), {
      initialProps: { id: "a", running: true },
    });
    // send 的闭包按渲染帧取 draft:setDraft 与 send 必须分属两个 act
    act(() => result.current.setDraft("排我"));
    act(() => {
      result.current.send(); // running=true → 入单槽
    });
    act(() => result.current.setDraft("A 的草稿"));
    expect(result.current.queued).toBe("排我");

    rerender({ id: "b", running: false });
    expect(result.current.draft).toBe("");
    expect(result.current.queued).toBeNull();

    rerender({ id: "a", running: true });
    expect(result.current.draft).toBe("A 的草稿");
    expect(result.current.queued).toBe("排我");
  });

  it("排队单槽:后发覆盖先发", () => {
    stubSend(() => null);
    const { result } = renderHook(() => useComposer("a", true));
    act(() => result.current.setDraft("第一条"));
    act(() => {
      result.current.send();
    });
    act(() => result.current.setDraft("第二条"));
    act(() => {
      result.current.send();
    });
    expect(result.current.queued).toBe("第二条");
  });

  it("发送失败不丢草稿(壳契约 Err ⟺ 未入会话)", async () => {
    stubSend(() => {
      throw new Error("engine down");
    });
    const { result } = renderHook(() => useComposer("a", false));
    act(() => result.current.setDraft("要发的话"));
    act(() => {
      result.current.send(); // setDraft 已提交,本 act 里的 send 闭包是新 draft
    });
    expect(result.current.draft).toBe("");
    await waitFor(() => expect(result.current.draft).toBe("要发的话"));
  });

  it("迟到的失败回执 + 已切会话:草稿回原会话留档,不污染当前会话", async () => {
    stubSend(() => {
      throw new Error("engine down");
    });
    const { result, rerender } = renderHook(({ id }) => useComposer(id, false), {
      initialProps: { id: "a" },
    });
    act(() => result.current.setDraft("迟到的话"));
    act(() => {
      result.current.send();
    });
    rerender({ id: "b" }); // 回执落地前切走
    await waitFor(() => expect(stashGet("a")?.draft).toBe("迟到的话"));
    expect(result.current.draft).toBe("");

    rerender({ id: "a" });
    expect(result.current.draft).toBe("迟到的话");
  });

  it("轮结束自动补投排队消息(payload 走 base64)", async () => {
    const calls = stubSend(() => null);
    const { result, rerender } = renderHook(({ running }) => useComposer("a", running), {
      initialProps: { running: true },
    });
    act(() => result.current.setDraft("排队中"));
    act(() => {
      result.current.send();
    });
    rerender({ running: false });
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "session_send" && JSON.stringify(c.args).includes(b64encode("排队中")))).toBe(true),
    );
    expect(result.current.queued).toBeNull();
  });
});
