/**
 * 麦克风 PCM 实时流（对齐 react-native-live-audio-stream 接口子集）。
 * AudioCapturer 采集 16kHz / 单声道 / PCM16，按帧 base64 后经
 * DeviceEventEmitter 事件 'RNLiveAudioStream.data' 发给 JS。
 */
import { TurboModule } from '@rnoh/react-native-openharmony/ts';
import { audio } from '@kit.AudioKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';

interface AudioOptions {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  audioSource?: number;
  bufferSize?: number;
}

export class LiveAudioStreamModule extends TurboModule {
  public static readonly NAME = 'RNLiveAudioStream';

  private capturer: audio.AudioCapturer | undefined = undefined;
  private base64 = new util.Base64Helper();
  private sampleRate: number = 16000;
  private channels: number = 1;

  init(options: AudioOptions): void {
    this.sampleRate = options.sampleRate ?? 16000;
    this.channels = options.channels ?? 1;
  }

  start(): void {
    if (this.capturer) {
      return;
    }
    const options: audio.AudioCapturerOptions = {
      streamInfo: {
        samplingRate: this.sampleRate === 16000
          ? audio.AudioSamplingRate.SAMPLE_RATE_16000
          : audio.AudioSamplingRate.SAMPLE_RATE_48000,
        channels: this.channels === 1 ? audio.AudioChannel.CHANNEL_1 : audio.AudioChannel.CHANNEL_2,
        sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
        encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW,
      },
      capturerInfo: {
        // 语音识别场景：系统会启用更适合 ASR 的降噪/回声消除策略
        source: audio.SourceType.SOURCE_TYPE_VOICE_RECOGNITION,
        capturerFlags: 0,
      },
    };

    audio.createAudioCapturer(options)
      .then((capturer: audio.AudioCapturer) => {
        this.capturer = capturer;
        capturer.on('readData', (buffer: ArrayBuffer) => {
          try {
            const b64 = this.base64.encodeToStringSync(new Uint8Array(buffer));
            // payload 直接是 base64 串，与 react-native-live-audio-stream 的 'data' 事件一致
            this.ctx.rnInstance.emitDeviceEvent('RNLiveAudioStream.data', b64);
          } catch (e) {
            const err = e as BusinessError;
            console.error(`[LiveAudioStream] encode/emit failed ${err.code}: ${err.message}`);
          }
        });
        return capturer.start();
      })
      .catch((e: BusinessError) => {
        console.error(`[LiveAudioStream] start failed ${e.code}: ${e.message}`);
        this.capturer = undefined;
      });
  }

  stop(): void {
    const c = this.capturer;
    if (!c) {
      return;
    }
    this.capturer = undefined;
    try {
      c.off('readData');
    } catch (_e) { /* noop */ }
    c.stop()
      .catch(() => {})
      .finally(() => {
        c.release().catch(() => {});
      });
  }

  __onDestroy__(): void {
    this.stop();
  }
}
