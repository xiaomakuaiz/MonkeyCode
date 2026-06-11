import {
  AnyJSBundleProvider,
  ComponentBuilderContext,
  FileJSBundleProvider,
  MetroJSBundleProvider,
  RNApp,
  RNOHCoreContext,
  RNOHErrorDialog,
} from '@rnoh/react-native-openharmony';
import { RNCWebView } from '@react-native-ohos/react-native-webview';
import { RNSScreenContentWrapper } from '@react-native-ohos/react-native-screens/src/main/ets/components/RNSScreenContentWrapper';
import { getRNOHPackages } from '../PackageProvider';
import { AlignedRawfileJSBundleProvider } from '../AlignedRawfileJSBundleProvider';

// ArkTS 实现的自定义组件需应用侧注册 builder（CAPI 组件无需）。
// - RNCWebView：webview 包不自带 builder map，需在此注册；
// - RNSScreenContentWrapper：screens 包的 builder map 故意不含它和 RNSScreen
//   （RNSScreen 由 RNSScreenStack 的 navDestinationBuilder 实例化），但 wrapper
//   必须有人渲染——它的 build 是 ContentSlot(getContentForTag(tag))，页面的全部
//   React 子内容都挂在它的 NodeContent 上，不注册则 NavDestination 空白（白屏）。
const arkTsComponentNames: Array<string> = [RNCWebView.NAME];

@Builder
export function buildCustomRNComponent(ctx: ComponentBuilderContext) {
  if (ctx.componentName === RNCWebView.NAME) {
    RNCWebView({
      ctx: ctx.rnComponentContext,
      tag: ctx.tag,
    })
  } else if (ctx.componentName === RNSScreenContentWrapper.NAME) {
    RNSScreenContentWrapper({
      ctx: ctx.rnComponentContext,
      tag: ctx.tag,
    })
  }
}

const wrappedCustomRNComponentBuilder = wrapBuilder<[ComponentBuilderContext]>(buildCustomRNComponent);

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
            arkTsComponentNames: arkTsComponentNames,
          },
          // 必须与 JS 侧 AppRegistry.registerComponent 的名字一致（mobile-harmony/index.js）
          appKey: 'MonkeyCode',
          wrappedCustomRNComponentBuilder: wrappedCustomRNComponentBuilder,
          jsBundleProvider: this.rnohCoreContext.isDebugModeEnabled
            ? new AnyJSBundleProvider([
              // 调试：连 Metro（hdc rport tcp:8081 tcp:8081，DevEco Sync 时插件自动转发）
              new MetroJSBundleProvider(),
              // 兜底：OTA 沙箱包 → 内置 rawfile 包
              new FileJSBundleProvider(`${this.rnohCoreContext.uiAbilityContext.filesDir}/ota/hermes_bundle.hbc`),
              new AlignedRawfileJSBundleProvider(this.rnohCoreContext.uiAbilityContext.resourceManager, 'hermes_bundle.hbc'),
            ])
            : new AnyJSBundleProvider([
              // 生产：优先 OTA 下发的沙箱包（MonkeyCodeNative.otaDownload 写入），否则内置包
              new FileJSBundleProvider(`${this.rnohCoreContext.uiAbilityContext.filesDir}/ota/hermes_bundle.hbc`),
              new AlignedRawfileJSBundleProvider(this.rnohCoreContext.uiAbilityContext.resourceManager, 'hermes_bundle.hbc'),
            ]),
        })
      }
    }
    .height('100%')
    .width('100%')
  }
}
