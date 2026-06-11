/**
 * 简写 ambient 声明：这些库的 ohos fork 自带源码与上游/React 19 类型不兼容，
 * 统一按 any 处理（仅影响 tsc 检查；运行时由 metro 的 harmony.alias 解析真实实现）。
 */
declare module 'react-native-safe-area-context';
declare module 'react-native-screens';
declare module 'react-native-screens/*';
