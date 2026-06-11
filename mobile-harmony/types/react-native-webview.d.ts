/**
 * react-native-webview 的最小类型（tsc 用；运行时由 harmony.alias 解析到
 * @react-native-ohos/react-native-webview 的真实实现）。
 * 覆盖主轨 PreviewBrowser.tsx / oauth.tsx 用到的 props 与 ref 方法。
 */
import * as React from 'react';

export type WebViewNavigation = {
  url: string;
  canGoBack: boolean;
  canGoForward?: boolean;
  loading?: boolean;
  title?: string;
};

export interface WebViewProps {
  source?: { uri: string; headers?: Record<string, string> };
  onLoadProgress?: (e: { nativeEvent: { progress: number } }) => void;
  onNavigationStateChange?: (event: WebViewNavigation) => void;
  onLoadStart?: () => void;
  onLoadEnd?: () => void;
  renderLoading?: () => React.ReactNode;
  [key: string]: unknown;
}

export class WebView extends React.Component<WebViewProps> {
  goBack(): void;
  goForward(): void;
  reload(): void;
  stopLoading(): void;
}

export default WebView;
