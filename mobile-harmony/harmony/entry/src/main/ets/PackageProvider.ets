import type { RNPackageContext, RNPackage } from '@rnoh/react-native-openharmony';
// DevEco Sync 时由 autolinking（link-harmony）生成，注册 @react-native-ohos/* 三方库
import { createRNOHPackages as createRNOHPackagesAutolinking } from './RNOHPackagesFactory';
import { MonkeyCodePackage } from './MonkeyCodePackage';

export function getRNOHPackages(ctx: RNPackageContext): RNPackage[] {
  return [
    ...createRNOHPackagesAutolinking(ctx),
    new MonkeyCodePackage(ctx),
  ];
}
