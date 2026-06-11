/** expo-status-bar shim：映射到 RN 内置 StatusBar（主轨只用了 style 一个 prop）。 */
import React from 'react';
import { StatusBar as RNStatusBar } from 'react-native';

export type StatusBarStyle = 'auto' | 'inverted' | 'light' | 'dark';

export function StatusBar({ style }: { style?: StatusBarStyle }): React.JSX.Element {
  const barStyle = style === 'light' ? 'light-content' : style === 'dark' ? 'dark-content' : 'default';
  return <RNStatusBar barStyle={barStyle} translucent backgroundColor="transparent" />;
}
