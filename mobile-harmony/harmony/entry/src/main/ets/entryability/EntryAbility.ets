import { RNAbility } from '@rnoh/react-native-openharmony';
import { AbilityConstant, appRecovery, Want } from '@kit.AbilityKit';

export default class EntryAbility extends RNAbility {
  override onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    super.onCreate(want, launchParam);
    // OTA：允许 appRecovery.restartApp() 重启进程以加载新 bundle（见 MonkeyCodeNativeModule.otaReload）
    appRecovery.enableAppRecovery(appRecovery.RestartFlag.ALWAYS_RESTART);
  }

  override getPagePath(): string {
    return 'pages/Index';
  }

  override getRNOHWorkerScriptUrl(): string {
    return 'entry/ets/workers/RNOHWorker.ets';
  }
}
