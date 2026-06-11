/**
 * RNOH 0.82 必备的 worker 入口。
 * 注意：必须用深路径直接 import setupRNOHWorker（从包根 import 会运行时报错，ArkTS 限制）。
 */
import { setupRNOHWorker } from '@rnoh/react-native-openharmony/src/main/ets/setupRNOHWorker';
import { getRNOHPackages } from '../PackageProvider';

setupRNOHWorker({
  createWorkerRNInstanceConfig: (_rnInstanceName: string) => {
    return { thirdPartyPackagesFactory: getRNOHPackages };
  },
});
