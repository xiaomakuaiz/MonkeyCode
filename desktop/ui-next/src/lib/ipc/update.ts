// 应用更新域:静默检查(窗口焦点驱动 + 30 分钟闸门)与安装。
// update_install 成功后壳会自行 app.restart(),UI 只需置 busy。
import { inDesktopShell, invoke } from "./ipc";

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest?: string;
}

export function updateCheck(): Promise<UpdateInfo | null> {
  if (!inDesktopShell()) return Promise.resolve(null);
  return invoke<UpdateInfo>("update_check").catch(() => null);
}

export function updateInstall(): Promise<void> {
  return invoke<void>("update_install").catch(() => {});
}

/** 30 分钟闸门:焦点每次触发,但静默检查最多半小时一次。纯函数可测。 */
export const UPDATE_GATE_MS = 30 * 60_000;

export function shouldCheckUpdate(now: number, lastAt: number | null, gateMs = UPDATE_GATE_MS): boolean {
  return lastAt === null || now - lastAt >= gateMs;
}
