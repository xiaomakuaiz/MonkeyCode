/**
 * react-native-svg 的最小类型（tsc 用；运行时由 harmony.alias 解析到
 * @react-native-ohos/react-native-svg）。覆盖主轨 Icons / ModelIcon / ui 用到的导出。
 */
import * as React from 'react';

export type SvgProps = { [key: string]: unknown };

declare const Svg: React.ComponentType<SvgProps>;
export default Svg;

export const Circle: React.ComponentType<SvgProps>;
export const Path: React.ComponentType<SvgProps>;
export const Rect: React.ComponentType<SvgProps>;
export const G: React.ComponentType<SvgProps>;
export const Line: React.ComponentType<SvgProps>;
export const Defs: React.ComponentType<SvgProps>;
export const LinearGradient: React.ComponentType<SvgProps>;
export const Stop: React.ComponentType<SvgProps>;
