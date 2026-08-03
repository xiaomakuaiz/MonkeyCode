import { afterEach, describe, expect, it, vi } from "vitest";

import {
  b64OfBytes,
  isImagePath,
  nativePathOf,
  pathBackedFile,
  pickAttachmentPaths,
  uploadFilePath,
  uploadFileStream,
} from "./uploads";

afterEach(() => vi.unstubAllGlobals());

interface Call {
  cmd: string;
  args?: Record<string, unknown>;
}

function stubShell(handler?: (cmd: string, args?: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("window", {
    __TAURI__: {
      core: {
        invoke: (cmd: string, args?: Record<string, unknown>) => {
          calls.push({ cmd, args });
          const r = handler?.(cmd, args);
          if (r instanceof Promise) return r;
          if (cmd === "upload_begin") return Promise.resolve({ handle: 7 });
          if (cmd === "upload_finish") return Promise.resolve({ path: ".monkeycode/uploads/a.bin" });
          return Promise.resolve(r ?? null);
        },
      },
    },
  });
  return calls;
}

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe("uploadFileStream 分块边界", () => {
  it("10 字节按 4 字节分块 → 3 块字节精确重组;begin/finish 契约与进度回调", async () => {
    const calls = stubShell();
    const progress: Array<[number, number]> = [];
    const f = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])], "big.bin", {
      type: "application/octet-stream",
    });
    const r = await uploadFileStream("s1", f, {
      chunkBytes: 4,
      onProgress: (sent, total) => progress.push([sent, total]),
    });
    expect(r).toEqual({ path: ".monkeycode/uploads/a.bin" });
    expect(calls[0]).toEqual({
      cmd: "upload_begin",
      args: { id: "s1", name: "big.bin", mediaType: "application/octet-stream" },
    });
    const chunks = calls.filter((c) => c.cmd === "upload_chunk");
    expect(chunks.map((c) => [...decode(c.args?.data as string)])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10],
    ]);
    expect(chunks.every((c) => c.args?.handle === 7)).toBe(true);
    expect(calls.at(-1)).toEqual({ cmd: "upload_finish", args: { handle: 7 } });
    expect(progress).toEqual([
      [4, 10],
      [8, 10],
      [10, 10],
    ]);
  });

  it("整除边界:8 字节 4 一块恰好 2 块,不多发空块", async () => {
    const calls = stubShell();
    const f = new File([new Uint8Array(8)], "a.bin", { type: "" });
    await uploadFileStream("s1", f, { chunkBytes: 4 });
    expect(calls.filter((c) => c.cmd === "upload_chunk")).toHaveLength(2);
  });

  it("空文件:零块直达 finish(壳侧落一个空文件)", async () => {
    const calls = stubShell();
    await uploadFileStream("s1", new File([], "empty.txt", { type: "text/plain" }), { chunkBytes: 4 });
    expect(calls.map((c) => c.cmd)).toEqual(["upload_begin", "upload_finish"]);
  });

  it("某块失败:upload_abort 销档,错误原样上抛,不再 finish", async () => {
    const calls = stubShell((cmd) => {
      if (cmd === "upload_chunk") return Promise.reject(new Error("disk full"));
      return undefined;
    });
    const f = new File([new Uint8Array(6)], "x.bin", { type: "" });
    await expect(uploadFileStream("s1", f, { chunkBytes: 4 })).rejects.toThrow("disk full");
    expect(calls.map((c) => c.cmd)).toEqual(["upload_begin", "upload_chunk", "upload_abort"]);
    expect(calls.at(-1)?.args).toEqual({ handle: 7 });
  });

  it("取消信号:下一块前中止,抛 AbortError 并 upload_abort", async () => {
    const ctl = new AbortController();
    const calls = stubShell((cmd) => {
      if (cmd === "upload_chunk") ctl.abort(); // 第一块落地后用户点了取消
      return undefined;
    });
    const f = new File([new Uint8Array(8)], "x.bin", { type: "" });
    await expect(uploadFileStream("s1", f, { chunkBytes: 4, signal: ctl.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls.filter((c) => c.cmd === "upload_chunk")).toHaveLength(1);
    expect(calls.some((c) => c.cmd === "upload_finish")).toBe(false);
    expect(calls.at(-1)?.cmd).toBe("upload_abort");
  });
});

describe("路径直拷与对话框选择", () => {
  it("uploadFilePath:{id, src} 契约透传", async () => {
    const calls = stubShell((cmd) => (cmd === "upload_file_path" ? { path: ".monkeycode/uploads/数据.csv" } : undefined));
    const r = await uploadFilePath("s1", "/home/u/数据.csv");
    expect(r.path).toBe(".monkeycode/uploads/数据.csv");
    expect(calls[0]).toEqual({ cmd: "upload_file_path", args: { id: "s1", src: "/home/u/数据.csv" } });
  });

  it("pickAttachmentPaths:数组/单串/取消(null)/浏览器模式各形态收敛", async () => {
    stubShell((cmd) => (cmd === "plugin:dialog|open" ? ["/a.png", "/b.txt"] : undefined));
    expect(await pickAttachmentPaths("选择附件")).toEqual(["/a.png", "/b.txt"]);

    stubShell((cmd) => (cmd === "plugin:dialog|open" ? "/only.png" : undefined));
    expect(await pickAttachmentPaths()).toEqual(["/only.png"]);

    stubShell(() => null);
    expect(await pickAttachmentPaths()).toEqual([]);

    vi.stubGlobal("window", {});
    expect(await pickAttachmentPaths()).toEqual([]);
  });
});

describe("path-backed File 与图片判定", () => {
  it("占位 File 带回真实路径;普通 File 无", () => {
    const f = pathBackedFile("/tmp/猫.png", "猫.png", "image/png");
    expect(nativePathOf(f)).toBe("/tmp/猫.png");
    expect(f.name).toBe("猫.png");
    expect(nativePathOf(new File([], "x"))).toBeUndefined();
  });

  it("isImagePath 与壳侧 image_mime 同口径", () => {
    expect(isImagePath(".monkeycode/uploads/a.PNG")).toBe(true);
    expect(isImagePath("b.jpeg")).toBe(true);
    expect(isImagePath("c.txt")).toBe(false);
    expect(isImagePath("noext")).toBe(false);
  });

  it("b64OfBytes 跨 32KB 段界仍逐字节一致", () => {
    const n = 0x8000 + 5;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = i % 251;
    expect([...decode(b64OfBytes(bytes.buffer))]).toEqual([...bytes]);
  });
});
