/**
 * react-native-live-audio-stream shim：对齐主轨用到的 JS 接口
 * （init/start/stop/on('data')），底层是自研 ArkTS TurboModule 'RNLiveAudioStream'
 * （AudioCapturer 16kHz PCM16 → DeviceEventEmitter 'RNLiveAudioStream.data'，payload 为 base64）。
 *
 * 额外提供 requestPermission()：鸿蒙运行时权限由原生申请（共享代码的
 * ensureMicPermission 探测到该方法时会调用；iOS 原版库没有此方法，互不影响）。
 */
import { DeviceEventEmitter } from 'react-native';
import type { Spec } from '../../specs/NativeLiveAudioStream';
import type { Spec as MonkeyCodeSpec } from '../../specs/NativeMonkeyCode';

let Native: Spec | null = null;
let MC: MonkeyCodeSpec | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Native = (require('../../specs/NativeLiveAudioStream') as { default: Spec }).default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  MC = (require('../../specs/NativeMonkeyCode') as { default: MonkeyCodeSpec }).default;
} catch {
  Native = null;
}

const LiveAudioStream = {
  init(options: object): void {
    Native?.init(options as Parameters<Spec['init']>[0]);
  },
  start(): void {
    Native?.start();
  },
  stop(): void {
    Native?.stop();
  },
  on(_event: 'data', cb: (b64: string) => void): { remove: () => void } {
    const sub = DeviceEventEmitter.addListener('RNLiveAudioStream.data', cb);
    return { remove: () => sub.remove() };
  },
  /** 鸿蒙扩展：申请麦克风权限。 */
  async requestPermission(): Promise<boolean> {
    if (!MC) return false;
    try {
      return await MC.requestMicPermission();
    } catch {
      return false;
    }
  },
};

// 原生模块不可用（如 codegen/注册缺失）时导出 null，主轨会按「语音不可用」优雅降级。
export default (Native ? LiveAudioStream : null) as typeof LiveAudioStream | null;
