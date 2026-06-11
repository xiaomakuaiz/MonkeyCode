/** expo-sharing shim → MonkeyCodeNative.shareFile（鸿蒙 ShareKit 系统分享面板）。 */
import type { Spec } from '../../specs/NativeMonkeyCode';

let Native: Spec | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Native = (require('../../specs/NativeMonkeyCode') as { default: Spec }).default;
} catch {
  Native = null;
}

export async function isAvailableAsync(): Promise<boolean> {
  return !!Native;
}

export async function shareAsync(
  uri: string,
  options?: { dialogTitle?: string; mimeType?: string },
): Promise<void> {
  if (!Native) throw new Error('分享能力不可用');
  await Native.shareFile(uri.replace(/^file:\/\//, ''), options?.mimeType ?? '', options?.dialogTitle ?? '');
}
