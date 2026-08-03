import { describe, expect, it } from "vitest";

import { DEFAULT_DIR, defaultWorkdir, workdirMatchesEnv } from "./workdir";

describe("workdirMatchesEnv(表驱动;语义 = 旧工程 host.ts)", () => {
  const cases: Array<[dir: string, kernelEnv: string, windowsShell: boolean, want: boolean]> = [
    // WSL 模式:guest posix / UNC(\\wsl$ 与 \\wsl.localhost)/ 盘符 / ~ 全放行
    ["/home/u/proj", "wsl:Ubuntu", true, true],
    ["\\\\wsl$\\Ubuntu\\home\\u\\proj", "wsl:Ubuntu", true, true],
    ["\\\\wsl.localhost\\Ubuntu\\home\\u", "wsl:Ubuntu", true, true],
    ["C:\\dev\\proj", "wsl:Ubuntu", true, true],
    ["d:/dev/proj", "wsl:Ubuntu", true, true],
    ["~/MonkeyCode", "wsl:Ubuntu", true, true],
    ["relative\\path", "wsl:Ubuntu", true, false],
    // 本机模式 + Windows 壳:posix 与 UNC 都是 WSL 遗留,滤掉
    ["/home/u/proj", "", true, false],
    ["\\\\wsl$\\Ubuntu\\home\\u", "", true, false],
    ["C:\\dev\\proj", "", true, true],
    ["~/MonkeyCode", "", true, true],
    // 本机模式 + 非 Windows 壳:/ 开头是正常路径,只滤 UNC
    ["/home/u/proj", "", false, true],
    ["\\\\wsl$\\Ubuntu\\home\\u", "", false, false],
    ["\\\\WSL.LOCALHOST\\Ubuntu\\home\\u", "", false, false],
    ["~/MonkeyCode", "", false, true],
  ];
  it.each(cases)("dir=%j env=%j win=%j → %j", (dir, kernelEnv, windowsShell, want) => {
    expect(workdirMatchesEnv(dir, kernelEnv, windowsShell)).toBe(want);
  });
});

describe("defaultWorkdir", () => {
  const cases: Array<[base: string | null, want: string]> = [
    [null, DEFAULT_DIR],
    ["", DEFAULT_DIR],
    ["\\\\wsl$\\Ubuntu\\home\\u", "\\\\wsl$\\Ubuntu\\home\\u\\MonkeyCode"],
    ["\\\\wsl$\\Ubuntu\\home\\u\\", "\\\\wsl$\\Ubuntu\\home\\u\\MonkeyCode"],
    // Linux 冒烟(fake-wsl):基座即 posix 家目录
    ["/home/u", "/home/u/MonkeyCode"],
    ["/home/u/", "/home/u/MonkeyCode"],
  ];
  it.each(cases)("base=%j → %j", (base, want) => {
    expect(defaultWorkdir(base)).toBe(want);
  });
});
