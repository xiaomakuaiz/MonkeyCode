const path = require('path');

// 双轨共享：业务代码在 ../mobile（Expo / RN 0.85 主轨），本工程是 RNOH 0.82 鸿蒙轨。
// expo-* 等主轨专属依赖通过 alias 替换为 ./shims 下的鸿蒙实现；JS import 名保持不变。
// 注意：react-native-webview / async-storage / safe-area-context / svg / image-picker /
// react-native-fs / @react-native-clipboard/clipboard 不在这里 alias —— 它们由
// @react-native-ohos/* 包的 harmony.alias 字段经 RNOH metro 配置自动重定向。
const MOBILE = path.resolve(__dirname, '../mobile');
const SHIMS = path.resolve(__dirname, 'shims');

module.exports = {
  presets: ['@react-native/babel-preset'],
  plugins: [
    [
      'module-resolver',
      {
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
        alias: {
          // 共享代码里的 '@/xxx' → mobile/src/xxx（与主轨 tsconfig paths 一致）
          '^@/(.+)': `${MOBILE}/src/\\1`,
          // 主轨专属模块 → 鸿蒙 shim
          'expo-router': `${SHIMS}/expo-router`,
          'expo-status-bar': `${SHIMS}/expo-status-bar`,
          'expo-constants': `${SHIMS}/expo-constants`,
          'expo-updates': `${SHIMS}/expo-updates`,
          'expo-clipboard': `${SHIMS}/expo-clipboard`,
          'expo-blur': `${SHIMS}/expo-blur`,
          'expo-file-system': `${SHIMS}/expo-file-system`,
          'expo-sharing': `${SHIMS}/expo-sharing`,
          'expo-image-picker': `${SHIMS}/expo-image-picker`,
          'expo-image-manipulator': `${SHIMS}/expo-image-manipulator`,
          'expo-media-library': `${SHIMS}/expo-media-library`,
          'react-native-keyboard-controller': `${SHIMS}/react-native-keyboard-controller`,
          'react-native-live-audio-stream': `${SHIMS}/react-native-live-audio-stream`,
          'react-native-quick-crypto': `${SHIMS}/react-native-quick-crypto`,
          // 仅被 ohos screens 的手势文件静态导入，运行时不会调用（见各 stub 注释）
          'react-native-gesture-handler': `${SHIMS}/react-native-gesture-handler`,
          'react-native-reanimated': `${SHIMS}/react-native-reanimated`,
        },
      },
    ],
  ],
};
