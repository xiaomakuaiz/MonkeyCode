/**
 * expo-updates shim（鸿蒙自研 OTA）。
 *
 * 协议（与 mobile/ota-server 的 /harmony/ 通道配套，静态文件可托管 OSS）：
 *   GET <updatesServer>/harmony/update.json
 *     → { id, createdAt, runtimeVersion, url, sha256 }
 *   id 变化且 runtimeVersion 与本机一致 → 视为有更新；
 *   下载/校验/原子生效由原生 MonkeyCodeNative.otaDownload 完成（写入沙箱
 *   files/ota/，下次启动由 Index.ets 的 FileJSBundleProvider 优先加载）；
 *   reloadAsync → appRecovery.restartApp。
 *
 * 主轨用到的 API：isEnabled / checkForUpdateAsync / fetchUpdateAsync / reloadAsync / updateId。
 */
import Constants from '../expo-constants';
import type { Spec } from '../../specs/NativeMonkeyCode';

let Native: Spec | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Native = (require('../../specs/NativeMonkeyCode') as { default: Spec }).default;
} catch {
  Native = null;
}

export const isEnabled: boolean = !__DEV__ && !!Native;

/** 当前生效（或已下载待重启）的更新 id；启动后异步填充（babel CJS 互操作下是活绑定）。 */
export let updateId: string | null = null;
if (Native) {
  void Native.otaGetCurrentId()
    .then((v) => {
      updateId = v || null;
    })
    .catch(() => {});
}

type RemoteUpdate = {
  id?: string;
  createdAt?: string;
  runtimeVersion?: string;
  url?: string;
  sha256?: string;
};

export type UpdateCheckResult = {
  isAvailable: boolean;
  manifest?: { id?: string; createdAt?: string };
};

let pending: { id: string; url: string; sha256: string } | null = null;

function updatesServer(): string | null {
  const extra = Constants.expoConfig?.extra as { updatesServer?: string } | undefined;
  return extra?.updatesServer?.replace(/\/+$/, '') ?? null;
}

export async function checkForUpdateAsync(): Promise<UpdateCheckResult> {
  if (!isEnabled || !Native) return { isAvailable: false };
  const base = updatesServer();
  if (!base) return { isAvailable: false };

  const res = await fetch(`${base}/harmony/update.json`, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`update.json HTTP ${res.status}`);
  const j = (await res.json()) as RemoteUpdate;
  if (!j?.id || !j?.url) return { isAvailable: false };
  // 运行时版本不匹配 = 需要新原生包，OTA 推不动（与 expo-updates 的 runtimeVersion 语义一致）
  if (j.runtimeVersion && j.runtimeVersion !== (Constants.expoConfig?.version ?? '')) {
    return { isAvailable: false };
  }
  const current = updateId ?? (await Native.otaGetCurrentId().catch(() => '')) ?? '';
  if (current === j.id) return { isAvailable: false };

  const url = /^https?:\/\//i.test(j.url) ? j.url : `${base}/harmony/${j.url.replace(/^\/+/, '')}`;
  pending = { id: j.id, url, sha256: j.sha256 ?? '' };
  return { isAvailable: true, manifest: { id: j.id, createdAt: j.createdAt } };
}

export async function fetchUpdateAsync(): Promise<{ isNew: boolean }> {
  if (!isEnabled || !Native) return { isNew: false };
  if (!pending) {
    const r = await checkForUpdateAsync();
    if (!r.isAvailable || !pending) return { isNew: false };
  }
  const p = pending;
  await Native.otaDownload(p.url, p.id, p.sha256);
  updateId = p.id;
  pending = null;
  return { isNew: true };
}

export async function reloadAsync(): Promise<void> {
  if (!Native) return;
  await Native.otaReload();
}
