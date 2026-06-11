import { hapTasks } from '@ohos/hvigor-ohos-plugin';
import { createRNOHModulePlugin } from '@rnoh/hvigor-plugin';

export default {
  system: hapTasks,
  plugins: [
    createRNOHModulePlugin({
      codegen: {
        // 应用自有 TurboModule（specs/）的 ets 类型输出位置
        etsOutputPath: './entry/src/main/ets/codegen',
      },
    }),
  ],
};
