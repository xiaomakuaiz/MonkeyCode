// 帧载荷编解码:纯函数,无 DOM/环境副作用(client.ts 顶层有 location/prompt,
// 单测在 node 环境导入会炸;归约层只依赖这里)。
import type { Frame } from "./types";

export function b64decode(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}

export function b64encode(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 解开帧 data(base64(JSON)) */
export function frameData<T = Record<string, unknown>>(f: Frame): T | null {
  if (!f.data) return null;
  try {
    return JSON.parse(b64decode(f.data)) as T;
  } catch {
    return null;
  }
}
