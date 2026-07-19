// chrome.debugger 薄封装:attach 幂等、detach 容错、sendCommand 透传,
// 错误统一映射为协议错误码(映射规则在 core.ts,可单测)。
// 已附加集合持久在 storage.session:debugger 附加关系跨 SW 休眠存活,
// 内存 Set 会在 SW 重启后丢失导致误判"未附加"。
import { mapDebuggerError } from "./core";
import type { RespError } from "./protocol";

const ATTACHED_KEY = "attachedTabs";
const CDP_VERSION = "1.3";

/** 携带协议错误码的异常,router 捕获后转应答帧 */
export class OpError extends Error {
  code: string;
  constructor(err: RespError) {
    super(err.message ?? err.code);
    this.code = err.code;
  }
  toResp(): RespError {
    return { code: this.code, message: this.message };
  }
}

function toOpError(e: unknown): OpError {
  if (e instanceof OpError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new OpError(mapDebuggerError(msg));
}

export async function getAttached(): Promise<Set<number>> {
  const got = await chrome.storage.session.get(ATTACHED_KEY);
  return new Set<number>(got[ATTACHED_KEY] ?? []);
}

async function setAttached(set: Set<number>): Promise<void> {
  await chrome.storage.session.set({ [ATTACHED_KEY]: [...set] });
}

export async function markDetached(tabId: number): Promise<void> {
  const set = await getAttached();
  if (set.delete(tabId)) await setAttached(set);
}

/** attach 幂等:已附加视为成功;"already attached" 且是我们自己附加的也视为成功 */
export async function attach(tabId: number): Promise<void> {
  const set = await getAttached();
  if (set.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // SW 重启后 session 记录还在但极端情况下可能失同步:自己重复 attach 会
    // 报 already attached,此时按幂等处理;真被 DevTools 等占用则由映射报冲突
    if (!/another debugger is already attached/i.test(msg) || !set.has(tabId)) {
      throw toOpError(e);
    }
  }
  set.add(tabId);
  await setAttached(set);
}

/** detach:"not attached" 类错误视为成功(目标可能已关闭或已被剥离) */
export async function detach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not attached|no target|no tab with/i.test(msg)) throw toOpError(e);
  } finally {
    await markDetached(tabId);
  }
}

/** CDP 命令透传,结果原样返回 */
export async function sendCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) ?? {};
  } catch (e) {
    throw toOpError(e);
  }
}
