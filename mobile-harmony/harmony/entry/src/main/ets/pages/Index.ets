import {
  AnyJSBundleProvider,
  FileJSBundleProvider,
  MetroJSBundleProvider,
  ResourceJSBundleProvider,
  RNApp,
  RNOHCoreContext,
  RNOHErrorDialog,
} from '@rnoh/react-native-openharmony';
import { getRNOHPackages } from '../PackageProvider';

@Entry
@Component
struct Index {
  @StorageLink('RNOHCoreContext') private rnohCoreContext: RNOHCoreContext | undefined = undefined;

  build() {
    Column() {
      if (this.rnohCoreContext) {
        if (this.rnohCoreContext.isDebugModeEnabled) {
          RNOHErrorDialog({ ctx: this.rnohCoreContext });
        }
        RNApp({
          rnInstanceConfig: {
            name: 'MonkeyCode',
            createRNPackages: getRNOHPackages,
            enableDebugger: this.rnohCoreContext.isDebugModeEnabled,
          },
          // 必须与 JS 侧 AppRegistry.registerComponent 的名字一致（mobile-harmony/index.js）
          appKey: 'MonkeyCode',
          jsBundleProvider: this.rnohCoreContext.isDebugModeEnabled
            ? new AnyJSBundleProvider([
              // 调试：连 Metro（hdc rport tcp:8081 tcp:8081，DevEco Sync 时插件自动转发）
              new MetroJSBundleProvider(),
              // 兜底：OTA 沙箱包 → 内置 rawfile 包
              new FileJSBundleProvider(`${this.rnohCoreContext.uiAbilityContext.filesDir}/ota/hermes_bundle.hbc`),
              new ResourceJSBundleProvider(this.rnohCoreContext.uiAbilityContext.resourceManager, 'hermes_bundle.hbc'),
            ])
            : new AnyJSBundleProvider([
              // 生产：优先 OTA 下发的沙箱包（MonkeyCodeNative.otaDownload 写入），否则内置包
              new FileJSBundleProvider(`${this.rnohCoreContext.uiAbilityContext.filesDir}/ota/hermes_bundle.hbc`),
              new ResourceJSBundleProvider(this.rnohCoreContext.uiAbilityContext.resourceManager, 'hermes_bundle.hbc'),
            ]),
        })
      }
    }
    .height('100%')
    .width('100%')
  }
}
