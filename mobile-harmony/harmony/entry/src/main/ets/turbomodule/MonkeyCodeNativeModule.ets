/**
 * MonkeyCode 自研原生能力（JS spec：mobile-harmony/specs/NativeMonkeyCode.ts）。
 *  - getCookies：读 ArkWeb Cookie 池（RNOH 的 fetch 写入；WebSocket 不自动带，JS 手动补）
 *  - requestMicPermission：麦克风运行时权限
 *  - shareFile：ShareKit 系统分享面板
 *  - saveImageToAlbum：系统「保存到相册」确认弹窗（无需预授权）
 *  - resizeImage：PixelMap 等比缩放 + ImagePacker 转 JPEG（图片附件压缩）
 *  - ota*：下载/校验/原子生效 JS bundle + 重启应用（见 pages/Index.ets 的加载顺序）
 */
import { TurboModule } from '@rnoh/react-native-openharmony/ts';
import { webview } from '@kit.ArkWeb';
import { abilityAccessCtrl, appRecovery, Permissions } from '@kit.AbilityKit';
import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor } from '@kit.ArkData';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { fileIo as fs, fileUri } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { http } from '@kit.NetworkKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { BusinessError } from '@kit.BasicServicesKit';

const MIC_PERMISSIONS: Array<Permissions> = ['ohos.permission.MICROPHONE'];

interface ResizeResult {
  uri: string;
  width: number;
  height: number;
}

interface OtaMeta {
  id: string;
}

export class MonkeyCodeNativeModule extends TurboModule {
  public static readonly NAME = 'MonkeyCodeNative';

  /* ------------------------------- Cookie ------------------------------- */

  async getCookies(url: string): Promise<string> {
    try {
      return webview.WebCookieManager.fetchCookieSync(url);
    } catch (_e) {
      return '';
    }
  }

  /* ------------------------------- 麦克风权限 ------------------------------- */

  async requestMicPermission(): Promise<boolean> {
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const result = await atManager.requestPermissionsFromUser(
        this.ctx.uiAbilityContext, MIC_PERMISSIONS);
      return result.authResults.every((r: number) => r === 0);
    } catch (e) {
      const err = e as BusinessError;
      console.error(`[MonkeyCode] requestMicPermission failed ${err.code}: ${err.message}`);
      return false;
    }
  }

  /* ------------------------------- 系统分享 ------------------------------- */

  async shareFile(path: string, mimeType: string, title: string): Promise<void> {
    let utdType: string = uniformTypeDescriptor.UniformDataType.FILE;
    if (mimeType) {
      try {
        const t = uniformTypeDescriptor.getUniformDataTypeByMIMEType(mimeType);
        if (t) {
          utdType = t;
        }
      } catch (_e) { /* 保持 FILE */ }
    }
    const data: systemShare.SharedData = new systemShare.SharedData({
      utd: utdType,
      uri: fileUri.getUriFromPath(path),
      title: title || undefined,
    });
    const controller: systemShare.ShareController = new systemShare.ShareController(data);
    await controller.show(this.ctx.uiAbilityContext, {
      selectionMode: systemShare.SelectionMode.SINGLE,
      previewMode: systemShare.SharePreviewMode.DETAIL,
    });
  }

  /* ------------------------------ 保存到相册 ------------------------------ */

  async saveImageToAlbum(path: string): Promise<void> {
    const helper = photoAccessHelper.getPhotoAccessHelper(this.ctx.uiAbilityContext);
    const parts = path.split('.');
    const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : 'jpg';
    const config: Array<photoAccessHelper.PhotoCreationConfig> = [{
      fileNameExtension: ext,
      photoType: photoAccessHelper.PhotoType.IMAGE,
    }];
    const srcUri = fileUri.getUriFromPath(path);
    const destUris = await helper.showAssetsCreationDialog([srcUri], config);
    if (!destUris || destUris.length === 0) {
      throw new Error('已取消保存');
    }
    // 把源文件内容写入系统返回的相册目标 uri
    const src = fs.openSync(path, fs.OpenMode.READ_ONLY);
    const dst = fs.openSync(destUris[0], fs.OpenMode.WRITE_ONLY);
    try {
      const buf = new ArrayBuffer(64 * 1024);
      let read = fs.readSync(src.fd, buf);
      while (read > 0) {
        fs.writeSync(dst.fd, buf, { length: read });
        read = fs.readSync(src.fd, buf);
      }
    } finally {
      fs.closeSync(src);
      fs.closeSync(dst);
    }
  }

  /* ------------------------------ 图片压缩 ------------------------------ */

  async resizeImage(uri: string, maxWidth: number, quality: number): Promise<ResizeResult> {
    const path = uri.startsWith('file://') ? uri.substring('file://'.length) : uri;
    const source = image.createImageSource(path);
    if (!source) {
      throw new Error('无法读取图片');
    }
    try {
      const info = await source.getImageInfo();
      let targetW = info.size.width;
      let targetH = info.size.height;
      if (maxWidth > 0 && info.size.width > maxWidth) {
        const scale = maxWidth / info.size.width;
        targetW = Math.round(info.size.width * scale);
        targetH = Math.round(info.size.height * scale);
      }
      const pixelMap = await source.createPixelMap({
        desiredSize: { width: targetW, height: targetH },
      });
      const packer = image.createImagePacker();
      try {
        const data = await packer.packing(pixelMap, {
          format: 'image/jpeg',
          quality: Math.max(1, Math.min(100, quality)),
        });
        const out = `${this.ctx.uiAbilityContext.cacheDir}/mc_resize_${Date.now()}.jpg`;
        const f = fs.openSync(out, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
        try {
          fs.writeSync(f.fd, data);
        } finally {
          fs.closeSync(f);
        }
        return { uri: out, width: targetW, height: targetH };
      } finally {
        packer.release().catch(() => {});
      }
    } finally {
      source.release().catch(() => {});
    }
  }

  /* --------------------------------- OTA --------------------------------- */

  private otaDir(): string {
    return `${this.ctx.uiAbilityContext.filesDir}/ota`;
  }

  private otaMetaPath(): string {
    return `${this.otaDir()}/update.json`;
  }

  /** Index.ets 的 FileJSBundleProvider 加载的就是这个路径。 */
  private otaBundlePath(): string {
    return `${this.otaDir()}/hermes_bundle.hbc`;
  }

  async otaGetCurrentId(): Promise<string> {
    try {
      if (!fs.accessSync(this.otaMetaPath())) {
        return '';
      }
      const content = fs.readTextSync(this.otaMetaPath());
      const meta = JSON.parse(content) as OtaMeta;
      return meta.id ?? '';
    } catch (_e) {
      return '';
    }
  }

  async otaDownload(url: string, id: string, sha256: string): Promise<void> {
    const httpRequest = http.createHttp();
    let data: ArrayBuffer;
    try {
      const resp = await httpRequest.request(url, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: 30000,
        readTimeout: 120000,
      });
      if (resp.responseCode !== 200) {
        throw new Error(`下载失败 HTTP ${resp.responseCode}`);
      }
      data = resp.result as ArrayBuffer;
    } finally {
      httpRequest.destroy();
    }
    if (!data || data.byteLength === 0) {
      throw new Error('下载内容为空');
    }
    if (sha256) {
      const md = cryptoFramework.createMd('SHA256');
      md.updateSync({ data: new Uint8Array(data) });
      const digest = md.digestSync();
      const hex = Array.from(digest.data)
        .map((b: number) => b.toString(16).padStart(2, '0'))
        .join('');
      if (hex.toLowerCase() !== sha256.toLowerCase()) {
        throw new Error('OTA 包校验失败（sha256 不匹配）');
      }
    }
    // 写 staging → 原子改名生效 → 写 meta
    if (!fs.accessSync(this.otaDir())) {
      fs.mkdirSync(this.otaDir(), true);
    }
    const staging = `${this.otaDir()}/staging.tmp`;
    const f = fs.openSync(staging, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(f.fd, data);
      fs.fsyncSync(f.fd);
    } finally {
      fs.closeSync(f);
    }
    fs.moveFileSync(staging, this.otaBundlePath(), 0);
    const meta: OtaMeta = { id };
    const mf = fs.openSync(this.otaMetaPath(), fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(mf.fd, JSON.stringify(meta));
    } finally {
      fs.closeSync(mf);
    }
  }

  async otaReload(): Promise<void> {
    appRecovery.restartApp();
  }
}
