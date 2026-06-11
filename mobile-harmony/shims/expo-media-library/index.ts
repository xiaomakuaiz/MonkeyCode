/**
 * expo-media-library shim：鸿蒙保存到相册走系统「保存确认」弹窗
 * （photoAccessHelper.showAssetsCreationDialog），无需预授权 —— 权限请求直接放行。
 */
import type { Spec } from '../../specs/NativeMonkeyCode';

let Native: Spec | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Native = (require('../../specs/NativeMonkeyCode') as { default: Spec }).default;
} catch {
  Native = null;
}

export async function requestPermissionsAsync(_writeOnly?: boolean): Promise<{
  granted: boolean;
  status: 'granted' | 'denied';
  canAskAgain: boolean;
}> {
  return { granted: !!Native, status: Native ? 'granted' : 'denied', canAskAgain: false };
}

export async function saveToLibraryAsync(localUri: string): Promise<void> {
  if (!Native) throw new Error('保存到相册不可用');
  await Native.saveImageToAlbum(localUri.replace(/^file:\/\//, ''));
}
