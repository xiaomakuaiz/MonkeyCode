import { JSBundleProvider, JSBundleProviderError } from '@rnoh/react-native-openharmony';
import type resmgr from '@ohos.resourceManager';

/**
 * 替代官方 ResourceJSBundleProvider 加载内置 hermes 字节码包。
 *
 * 官方实现存在 RNOHCoreContext 时走 mmap 直接映射 HAP 包内的 rawfile，
 * 而 .hbc 在 HAP（zip）里的字节偏移不保证 8 字节对齐，Hermes 校验字节码
 * buffer 对齐失败 → "compiling JS failed: buffer misaligned"（RNOH 0.82.31）。
 * 这里改为 getRawFileContent 整体读入堆内存（分配天然对齐），绕开 mmap。
 */
export class AlignedRawfileJSBundleProvider extends JSBundleProvider {
  private resourceManager: resmgr.ResourceManager;
  private path: string;
  private appKeys: string[];

  constructor(resourceManager: resmgr.ResourceManager, path: string, appKeys: string[] = []) {
    super();
    this.resourceManager = resourceManager;
    this.path = path;
    this.appKeys = appKeys;
  }

  getURL(): string {
    return this.path;
  }

  getAppKeys(): string[] {
    return this.appKeys;
  }

  async getBundle(
    onProgress?: (progress: number) => void,
    onProviderSwitch?: (currentProvider: JSBundleProvider) => void
  ): Promise<ArrayBuffer> {
    try {
      const content = await this.resourceManager.getRawFileContent(this.path);
      // Uint8Array 可能是大 buffer 的视图，slice 拷出从 0 开始的独立 ArrayBuffer
      return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    } catch (err) {
      throw new JSBundleProviderError({
        whatHappened: `Couldn't load JSBundle from rawfile: ${this.path}`,
        extraData: err,
        howCanItBeFixed: [`Check if a bundle exists at "rawfile/${this.path}" (npm run bundle:harmony).`],
      });
    }
  }
}
