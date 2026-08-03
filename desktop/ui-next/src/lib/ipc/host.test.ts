import { afterEach, describe, expect, it, vi } from "vitest";

import { hostInfo, hostPlatform, isMacShell, isWindowsShell } from "./host";

afterEach(() => vi.unstubAllGlobals());

function stubShell(ua: string, invoke: (cmd: string) => Promise<unknown> = () => Promise.resolve(null)) {
  vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
  vi.stubGlobal("navigator", { userAgent: ua });
}

describe("平台探测", () => {
  it("浏览器模式:无 __TAURI__ 即 browser,不看 UA", () => {
    vi.stubGlobal("window", {});
    expect(hostPlatform()).toBe("browser");
    expect(isMacShell()).toBe(false);
    expect(isWindowsShell()).toBe(false);
  });

  it("壳内按 UA 分平台", () => {
    stubShell("Macintosh; Intel Mac OS X 10_15_7");
    expect(hostPlatform()).toBe("mac");
    stubShell("Windows NT 10.0; Win64");
    expect(hostPlatform()).toBe("windows");
    stubShell("X11; Linux x86_64");
    expect(hostPlatform()).toBe("linux");
  });
});

describe("hostInfo", () => {
  it("浏览器模式返回 null;壳内透传;命令失败也回落 null(启动期不炸 UI)", async () => {
    vi.stubGlobal("window", {});
    expect(await hostInfo()).toBeNull();

    stubShell("Windows NT 10.0", vi.fn(() => Promise.resolve({ version: "1.2.3", engine_version: null })));
    expect(await hostInfo()).toEqual({ version: "1.2.3", engine_version: null });

    stubShell("Windows NT 10.0", vi.fn(() => Promise.reject(new Error("boom"))));
    expect(await hostInfo()).toBeNull();
  });
});
