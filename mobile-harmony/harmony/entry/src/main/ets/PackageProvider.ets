import type { RNPackageContext, RNPackage } from '@rnoh/react-native-openharmony';
// DevEco Sync 时由 autolinking（link-harmony）生成，注册 @react-native-ohos/* 三方库
import { createRNOHPackages as createRNOHPackagesAutolinking } from './RNOHPackagesFactory';
import { MonkeyCodePackage } from './MonkeyCodePackage';
// 手动接入的三方库（har 无 autolinking 元数据，link-harmony 跳过，见 cpp/CMakeLists.txt）
import { ClipboardPackage } from '@react-native-ohos/clipboard';
import { SafeAreaViewPackage } from '@react-native-ohos/react-native-safe-area-context';
import RNOHScreensPackage from '@react-native-ohos/react-native-screens';
import { SvgPackage } from '@react-native-ohos/react-native-svg';
import { RNCWebViewPackage } from '@react-native-ohos/react-native-webview';
import { ImagePickerViewPackage } from '@react-native-ohos/react-native-image-picker';

export function getRNOHPackages(ctx: RNPackageContext): RNPackage[] {
  return [
    ...createRNOHPackagesAutolinking(ctx),
    new MonkeyCodePackage(ctx),
    new ClipboardPackage(ctx),
    new SafeAreaViewPackage(ctx),
    new RNOHScreensPackage(ctx),
    new SvgPackage(ctx),
    new RNCWebViewPackage(ctx),
    new ImagePickerViewPackage(ctx),
  ];
}
