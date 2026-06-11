/**
 * 鸿蒙自研原生能力（ArkTS TurboModule，实现见 harmony/entry/src/main/ets/turbomodule/）。
 * 经 codegen（package.json harmony.codegenConfig）生成 cpp/ets 胶水。
 */
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /** 读 ArkWeb Cookie 池里某 URL 的 Cookie 串（RNOH 的 fetch 写入、WebSocket 不自动带，需手动取）。 */
  getCookies(url: string): Promise<string>;
  /** 申请麦克风权限（语音输入用）。 */
  requestMicPermission(): Promise<boolean>;
  /** 系统分享面板分享一个本地文件。 */
  shareFile(path: string, mimeType: string, title: string): Promise<void>;
  /** 保存本地图片到相册（走系统保存确认弹窗，无需预授权）。 */
  saveImageToAlbum(path: string): Promise<void>;
  /** 等比缩放到 maxWidth（0 = 不缩放）并按 quality(0-100) 转 JPEG，返回新文件。 */
  resizeImage(uri: string, maxWidth: number, quality: number): Promise<{
    uri: string;
    width: number;
    height: number;
  }>;
  /** 当前已下载生效（或待重启生效）的 OTA 更新 id；无 OTA 时返回空串。 */
  otaGetCurrentId(): Promise<string>;
  /** 下载 OTA bundle 到沙箱并原子生效（下次启动加载）；sha256 非空时校验。 */
  otaDownload(url: string, id: string, sha256: string): Promise<void>;
  /** 重启应用以应用 OTA（appRecovery.restartApp）。 */
  otaReload(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('MonkeyCodeNative');
