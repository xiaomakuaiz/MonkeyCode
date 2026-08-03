import { afterEach, describe, expect, it, vi } from "vitest";

import { modelsList, onSessionEvent, sessionCreate, sessionPatch, sessionsList } from "./sessions";

afterEach(() => vi.unstubAllGlobals());

describe("会话域 API", () => {
  it("浏览器模式:列表类返回空、变更类 reject、事件订阅为 no-op", async () => {
    vi.stubGlobal("window", {});
    expect(await sessionsList()).toEqual([]);
    expect(await modelsList()).toEqual([]);
    await expect(sessionCreate({ workdir: "/a", model: "m", createDir: false })).rejects.toThrow();
    expect(onSessionEvent(() => {})).toBeTypeOf("function");
  });

  it("壳内:命令名与参数按契约透传(camelCase 由 Tauri 映射)", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    vi.stubGlobal("window", {
      __TAURI__: {
        core: {
          invoke: (cmd: string, args?: Record<string, unknown>) => {
            calls.push({ cmd, args });
            if (cmd === "sessions_list") return Promise.resolve([{ id: "s1" }]);
            return Promise.resolve({ ok: true });
          },
        },
      },
    });
    await sessionsList();
    await sessionCreate({ workdir: "/w", model: "m", createDir: true, kind: "chat" });
    await sessionPatch("s1", { archived: true });
    expect(calls[0]?.cmd).toBe("sessions_list");
    expect(calls[1]).toEqual({
      cmd: "session_create",
      args: { workdir: "/w", model: "m", createDir: true, kind: "chat" },
    });
    expect(calls[2]).toEqual({ cmd: "session_patch", args: { id: "s1", patch: { archived: true } } });
  });

  it("壳内列表命令失败回落空数组(启动期引擎未就绪不炸 UI)", async () => {
    vi.stubGlobal("window", {
      __TAURI__: { core: { invoke: () => Promise.reject(new Error("engine starting")) } },
    });
    expect(await sessionsList()).toEqual([]);
  });
});
