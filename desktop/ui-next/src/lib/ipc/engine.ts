// 引擎域 API:状态快照/重启/状态事件。EngineStatus 判别联合来自 ts-rs 生成
// (gen/EngineStatus.ts)。浏览器模式:快照 null、事件 no-op、重启静默失败。
import type { EngineStatus } from "@/gen/EngineStatus";
import { inDesktopShell, invoke, listen } from "./ipc";

export type { EngineStatus };

/** 状态快照补拉(事件可能在挂监听前就 emit 过,进视图先拉一次)。 */
export function engineStatus(): Promise<EngineStatus | null> {
  if (!inDesktopShell()) return Promise.resolve(null);
  return invoke<EngineStatus>("engine_status").catch(() => null);
}

/** 按当前配置重启引擎(幂等;错误页同款入口)。
 *  失败不吞:调用方(横幅)需要据此复位忙态并外显错误,吞掉就是按钮永转。 */
export function engineRestart(): Promise<void> {
  return invoke<void>("engine_restart");
}

export function onEngineStatus(cb: (s: EngineStatus) => void): () => void {
  return listen<EngineStatus>("engine-status", cb);
}
