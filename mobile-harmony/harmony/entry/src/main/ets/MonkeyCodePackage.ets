/**
 * 应用自有 TurboModule 注册：
 *  - MonkeyCodeNative：Cookie / 分享 / 相册 / 图片压缩 / OTA / 麦克风权限
 *  - RNLiveAudioStream：麦克风 PCM 实时流（语音输入）
 * JS 侧 spec 见 mobile-harmony/specs/。
 */
import { RNPackage, TurboModulesFactory } from '@rnoh/react-native-openharmony/ts';
import type { TurboModule, TurboModuleContext } from '@rnoh/react-native-openharmony/ts';
import { MonkeyCodeNativeModule } from './turbomodule/MonkeyCodeNativeModule';
import { LiveAudioStreamModule } from './turbomodule/LiveAudioStreamModule';

class MonkeyCodeTurboModulesFactory extends TurboModulesFactory {
  createTurboModule(name: string): TurboModule | null {
    if (name === MonkeyCodeNativeModule.NAME) {
      return new MonkeyCodeNativeModule(this.ctx);
    }
    if (name === LiveAudioStreamModule.NAME) {
      return new LiveAudioStreamModule(this.ctx);
    }
    return null;
  }

  hasTurboModule(name: string): boolean {
    return name === MonkeyCodeNativeModule.NAME || name === LiveAudioStreamModule.NAME;
  }
}

export class MonkeyCodePackage extends RNPackage {
  createTurboModulesFactory(ctx: TurboModuleContext): TurboModulesFactory {
    return new MonkeyCodeTurboModulesFactory(ctx);
  }
}
