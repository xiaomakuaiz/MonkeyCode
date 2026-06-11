/**
 * expo-blur shim：鸿蒙轨与主轨 Android 同策略 —— 半透明纯色替代毛玻璃。
 * （glass.tsx 在 Android 上本就降级为纯色；如后续要真毛玻璃，可换 @react-native-ohos/blur。）
 */
import React from 'react';
import { View } from 'react-native';
import type { ViewProps } from 'react-native';

export type BlurViewProps = ViewProps & {
  intensity?: number;
  tint?: 'light' | 'dark' | 'default' | string;
};

export function BlurView({ intensity = 50, tint = 'light', style, children, ...rest }: BlurViewProps): React.JSX.Element {
  // intensity 越高越接近不透明，与毛玻璃观感方向一致
  const alpha = Math.min(1, 0.6 + (Math.max(0, Math.min(100, intensity)) / 100) * 0.38);
  const backgroundColor = tint === 'dark' ? `rgba(24,24,28,${alpha})` : `rgba(250,250,252,${alpha})`;
  return (
    <View {...rest} style={[style, { backgroundColor }]}>
      {children}
    </View>
  );
}
