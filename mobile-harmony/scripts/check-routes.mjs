#!/usr/bin/env node
/**
 * 路由表防漂移校验：主轨 mobile/app 是 expo-router 文件路由，鸿蒙轨在
 * src/App.tsx 手工注册（registerScreens）。主轨新增路由而鸿蒙轨忘记注册时，
 * 用户点击跳转才会运行时报错 —— 本脚本在 typecheck 阶段就拦下。
 *
 * 映射规则（与 shims/expo-router 的注册键一致）：
 *   app/index.tsx        → 'index'
 *   app/(tabs)/_layout   → '(tabs)'
 *   app/(tabs)/tasks.tsx → 'tasks'（tab 子路由用裸名）
 *   app/task/[id].tsx    → 'task/[id]'
 *   app/_layout.tsx      → 根布局，不注册（App.tsx 直接 import）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, '../mobile/app');
const REGISTRY_FILE = path.join(ROOT, 'src/App.tsx');

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (/\.tsx?$/.test(e.name)) out.push(rel.replace(/\.tsx?$/, ''));
  }
  return out;
}

const expected = new Set();
for (const route of walk(APP_DIR)) {
  if (route === '_layout') continue; // 根布局由 App.tsx 直接 import
  if (route.endsWith('/_layout')) {
    expected.add(route.replace(/\/_layout$/, '')); // '(tabs)/_layout' → '(tabs)'
  } else if (route.startsWith('(tabs)/')) {
    expected.add(route.slice('(tabs)/'.length)); // tab 子路由用裸名
  } else {
    expected.add(route);
  }
}

const src = fs.readFileSync(REGISTRY_FILE, 'utf8');
const block = src.match(/registerScreens\(\{([\s\S]*?)\}\);/);
if (!block) {
  console.error(`[check-routes] ${REGISTRY_FILE} 里没找到 registerScreens({...}) 块`);
  process.exit(1);
}
const registered = new Set(
  [...block[1].matchAll(/^\s*(?:'([^']+)'|([A-Za-z0-9_$]+)):/gm)].map((m) => m[1] ?? m[2]),
);

const missing = [...expected].filter((r) => !registered.has(r));
const stale = [...registered].filter((r) => !expected.has(r));

if (missing.length || stale.length) {
  if (missing.length) console.error(`[check-routes] 鸿蒙轨缺少路由注册：${missing.join(', ')}\n  → 在 mobile-harmony/src/App.tsx 的 registerScreens 里补上`);
  if (stale.length) console.error(`[check-routes] 注册表存在主轨已不存在的路由：${stale.join(', ')}`);
  process.exit(1);
}
console.log(`[check-routes] OK：${registered.size} 个路由与 mobile/app 一致`);
