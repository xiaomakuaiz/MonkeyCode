/**
 * expo-image-manipulator shim → MonkeyCodeNative.resizeImage
 * （ArkTS image kit：PixelMap 等比缩放 + ImagePacker 按质量转 JPEG）。
 * 主轨只用了 [{ resize: { width } }] + { compress, format: JPEG }。
 */
import type { Spec } from '../../specs/NativeMonkeyCode';

// 守卫式 require：原生模块缺失时不在 import 期抛错（与其余 shim 一致），
// 否则会把「图片压缩不可用」放大成启动崩溃（本模块被任务页顶层 import）。
let Native: Spec | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Native = (require('../../specs/NativeMonkeyCode') as { default: Spec }).default;
} catch {
  Native = null;
}

export enum SaveFormat {
  JPEG = 'jpeg',
  PNG = 'png',
  WEBP = 'webp',
}

export type Action = { resize?: { width?: number; height?: number } };

export async function manipulateAsync(
  uri: string,
  actions: Action[] = [],
  options?: { compress?: number; format?: SaveFormat },
): Promise<{ uri: string; width: number; height: number }> {
  if (!Native) throw new Error('图片处理能力不可用');
  const width = actions.find((a) => a.resize)?.resize?.width ?? 0;
  const quality = Math.round(Math.min(1, Math.max(0, options?.compress ?? 0.9)) * 100);
  const out = await Native.resizeImage(uri.replace(/^file:\/\//, ''), width, quality);
  return { uri: out.uri.startsWith('file://') ? out.uri : `file://${out.uri}`, width: out.width, height: out.height };
}
