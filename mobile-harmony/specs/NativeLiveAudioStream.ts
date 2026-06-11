/**
 * 麦克风 PCM 实时流（对齐 react-native-live-audio-stream 的原生接口子集）。
 * ArkTS 侧用 AudioCapturer 采集，按 chunk 以 DeviceEventEmitter 事件
 * 'RNLiveAudioStream.data'（payload = base64 PCM16LE）回调 JS。
 */
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  init(options: {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    audioSource: number;
    bufferSize: number;
  }): void;
  start(): void;
  stop(): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RNLiveAudioStream');
