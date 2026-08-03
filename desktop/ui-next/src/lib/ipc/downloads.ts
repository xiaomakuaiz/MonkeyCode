// 全局下载(云端 VM 文件落本地):模块级 store + useSyncExternalStore 订阅。
// 契约:dlId 由 UI 生成;必须先挂 dl-progress:{dlId} 监听再 invoke
// mc_file_download(首帧 written=0 带 total,壳同步就发);取消走
// mc_file_download_cancel;完成后可在文件管理器中定位(plugin:opener)。
import { useSyncExternalStore } from "react";

import { invoke, listenAsync } from "./ipc";

export type DownloadState = "running" | "done" | "error" | "canceled";

export interface DownloadItem {
  dlId: string;
  filename: string;
  dest: string;
  written: number;
  total: number | null;
  state: DownloadState;
  /** 失败原因(壳的 Err 中文文案,直接外显) */
  error?: string;
}

let items: DownloadItem[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const cb of listeners) cb();
}

function patch(dlId: string, up: Partial<DownloadItem>) {
  items = items.map((d) => (d.dlId === dlId ? { ...d, ...up } : d));
  notify();
}

export function getDownloads(): DownloadItem[] {
  return items;
}

export function useDownloads(): DownloadItem[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getDownloads,
    getDownloads,
  );
}

export function dismissDownload(dlId: string): void {
  items = items.filter((d) => d.dlId !== dlId);
  notify();
}

export function cancelDownload(dlId: string): void {
  patch(dlId, { state: "canceled" });
  void invoke("mc_file_download_cancel", { dlId }).catch(() => {});
}

export async function startDownload(args: {
  vmId: string;
  path: string;
  filename: string;
  dest: string;
}): Promise<void> {
  const dlId = crypto.randomUUID();
  items = [...items, { dlId, filename: args.filename, dest: args.dest, written: 0, total: null, state: "running" }];
  notify();
  // 铁律:先挂进度监听再发命令(首帧同步到达)
  const off = await listenAsync<{ written: number; total: number | null }>(`dl-progress:${dlId}`, (p) => {
    patch(dlId, { written: p.written, total: p.total ?? null });
  });
  try {
    await invoke<{ ok: boolean; bytes: number }>("mc_file_download", { dlId, ...args });
    patch(dlId, { state: "done" });
  } catch (e) {
    // 用户主动取消的不降级为 error(取消已置态)
    const current = items.find((d) => d.dlId === dlId);
    if (current?.state === "running") {
      patch(dlId, { state: "error", error: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    off();
  }
}

/** 在文件管理器中定位产物。opener 插件的命令签名是
 * `reveal_item_in_dir(paths: Vec<PathBuf>)`——参数名必须是 paths 数组,
 * 传 {path} 会反序列化失败且无声(旧 UI 踩过);失败留 console 便于诊断,
 * 路径本身就在下载卡上,用户仍可自寻。 */
export function revealDownload(item: DownloadItem): void {
  void invoke("plugin:opener|reveal_item_in_dir", { paths: [item.dest] }).catch((e: unknown) => {
    console.warn("[downloads] 文件管理器定位失败:", e);
  });
}

/** 仅测试用:清空 store。 */
export function resetDownloadsForTest(): void {
  items = [];
  notify();
}
