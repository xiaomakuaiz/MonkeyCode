/**
 * 路由注册表：键 = expo-router 文件路由名（与主轨 mobile/app 目录一一对应），
 * 值 = 惰性组件 loader。由 src/App.tsx 在启动时注册。
 */
import type { ComponentType } from 'react';

type Loader = () => ComponentType<Record<string, unknown>>;

const loaders: Record<string, Loader> = {};
const cache: Record<string, ComponentType<Record<string, unknown>>> = {};

export function registerScreens(map: Record<string, Loader>): void {
  Object.assign(loaders, map);
}

export function getScreen(name: string): ComponentType<Record<string, unknown>> {
  if (!cache[name]) {
    const loader = loaders[name];
    if (!loader) throw new Error(`[expo-router shim] 未注册的路由：${name}`);
    cache[name] = loader();
  }
  return cache[name];
}

export function getRouteNames(): string[] {
  return Object.keys(loaders);
}
