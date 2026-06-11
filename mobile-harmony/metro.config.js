const path = require('path');
const { mergeConfig, getDefaultConfig } = require('@react-native/metro-config');
const {
  createHarmonyMetroConfig,
} = require('@react-native-oh/react-native-harmony/metro.config');

const ROOT = __dirname;
const MOBILE = path.resolve(ROOT, '../mobile');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @type {import("metro-config").MetroConfig}
 *
 * 双轨要点：
 *  - watchFolders 带上 ../mobile，业务代码（src/ + app/）直接从主轨引用；
 *  - 但依赖必须解析到本工程的 node_modules（RN 0.82 / RNOH），所以关掉向上查找并屏蔽
 *    mobile/node_modules（那里是 RN 0.85 / Expo，混进来会炸）；
 *  - expo-* → shims 的重定向在 babel.config.js（module-resolver）里做，避免覆盖
 *    createHarmonyMetroConfig 的 resolveRequest（它负责 @react-native-ohos/* 的 harmony.alias）。
 */
const config = {
  watchFolders: [MOBILE],
  resolver: {
    // ../mobile 源码的依赖兜底解析到本工程 node_modules；保留层级查找
    // （@react-native-ohos/* 内部嵌套 node_modules 的深层 import 依赖它）
    nodeModulesPaths: [path.join(ROOT, 'node_modules')],
    // mobile/node_modules 是 RN 0.85 / Expo（主轨），绝不能混进鸿蒙 bundle
    blockList: [/\.cxx/, new RegExp(`${escapeRegExp(path.join(MOBILE, 'node_modules'))}/.*`)],
    // 未安装包的兜底映射（babel alias 不作用于 node_modules 内部的 import）：
    // ohos screens 的手势文件静态导入这两个库，运行时不会调用（见 stub 注释）
    extraNodeModules: {
      'react-native-gesture-handler': path.join(ROOT, 'shims/react-native-gesture-handler'),
      'react-native-reanimated': path.join(ROOT, 'shims/react-native-reanimated'),
    },
  },
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
};

module.exports = mergeConfig(
  getDefaultConfig(ROOT),
  createHarmonyMetroConfig({
    reactNativeHarmonyPackageName: '@react-native-oh/react-native-harmony',
  }),
  config,
);
