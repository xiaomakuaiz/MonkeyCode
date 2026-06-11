/**
 * 鸿蒙轨根组件：注册 expo-router 风格的路由表（键 = 主轨 mobile/app 下的文件路由名），
 * 然后直接复用主轨的根布局（Provider 嵌套 + 鉴权导航 + OTA 提示都在里面）。
 *
 * 路由组件全部从 ../mobile/app 引用 —— 鸿蒙轨不复制任何页面代码。
 * 用 () => require() 惰性取组件，避免「页面 → expo-router shim → 注册表」的环形依赖。
 */
import React from 'react';
import { registerScreens } from '../shims/expo-router/registry';
import RootLayout from '../../mobile/app/_layout';

registerScreens({
  index: () => require('../../mobile/app/index').default,
  login: () => require('../../mobile/app/login').default,
  oauth: () => require('../../mobile/app/oauth').default,
  '(tabs)': () => require('../../mobile/app/(tabs)/_layout').default,
  tasks: () => require('../../mobile/app/(tabs)/tasks').default,
  projects: () => require('../../mobile/app/(tabs)/projects').default,
  profile: () => require('../../mobile/app/(tabs)/profile').default,
  'task/[id]': () => require('../../mobile/app/task/[id]').default,
  'project/[id]': () => require('../../mobile/app/project/[id]').default,
  'new-task': () => require('../../mobile/app/new-task').default,
});

export default function App() {
  return <RootLayout />;
}
