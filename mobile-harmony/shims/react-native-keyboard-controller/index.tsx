/**
 * react-native-keyboard-controller shim：该库无鸿蒙适配。
 * KeyboardProvider → 透传；KeyboardAvoidingView → RN 内置实现（主轨只用了 behavior="padding"）。
 */
import React from 'react';

export { KeyboardAvoidingView } from 'react-native';

export function KeyboardProvider({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <>{children}</>;
}
