#!/usr/bin/env node
/**
 * 导出鸿蒙 OTA 包到 dist-harmony/：
 *   1. react-native bundle-harmony（hermes 字节码，与装机包同构）
 *   2. 拷贝 hermes_bundle.hbc + 生成 update.json（id = 内容 sha256 派生，原样可托管 OSS）
 *
 * 产物：
 *   dist-harmony/hermes_bundle.hbc
 *   dist-harmony/update.json   { id, createdAt, runtimeVersion, url, sha256 }
 *
 * 服务端（mobile/ota-server）把 dist-harmony 挂在 /harmony/ 下；客户端
 * （shims/expo-updates）按 update.json 的 id/runtimeVersion 决定是否下载。
 *
 * 注意：bundle-harmony 依赖 hermesc 二进制（node_modules/react-native/sdks/hermesc），
 * Linux/macOS 均可执行。
 */
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAWFILE = path.join(ROOT, 'harmony/entry/src/main/resources/rawfile');
const DIST = path.join(ROOT, 'dist-harmony');

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, '../mobile/app.json'), 'utf8'));
const runtimeVersion = String(appJson.expo?.version ?? '');
if (!runtimeVersion) throw new Error('mobile/app.json 里没有 expo.version');

// 发版护栏：app.json（Constants/runtimeVersion 的来源）与鸿蒙原生包的 versionName
// 必须一致，否则装机版本与 OTA runtimeVersion 错位 → OTA 永远拒发。json5 有尾逗号，用正则取。
const appJson5 = fs.readFileSync(path.join(ROOT, 'harmony/AppScope/app.json5'), 'utf8');
const versionName = appJson5.match(/"versionName"\s*:\s*"([^"]+)"/)?.[1] ?? '';
if (versionName !== runtimeVersion) {
  throw new Error(
    `版本号不一致：mobile/app.json expo.version=${runtimeVersion}，` +
    `harmony/AppScope/app.json5 versionName=${versionName}。发版前请同步两处（见 README 发版清单）。`,
  );
}

console.log('[ota] bundle-harmony（hermes）…');
execSync('npx react-native bundle-harmony --dev=false --minify=true --js-engine=hermes', {
  cwd: ROOT,
  stdio: 'inherit',
});

const bundleSrc = path.join(RAWFILE, 'hermes_bundle.hbc');
if (!fs.existsSync(bundleSrc)) throw new Error(`没找到 ${bundleSrc}（bundle-harmony 失败？）`);

fs.mkdirSync(DIST, { recursive: true });
const buf = fs.readFileSync(bundleSrc);
fs.writeFileSync(path.join(DIST, 'hermes_bundle.hbc'), buf);

const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
const update = {
  id: sha256.slice(0, 32), // 内容变 id 才变，客户端按 id 去重
  createdAt: new Date().toISOString(),
  runtimeVersion, // 与装机包 app.json version 一致才下发（原生不兼容的包推不动）
  url: 'hermes_bundle.hbc', // 相对 update.json 所在目录；托管 OSS 时可改绝对地址
  sha256,
};
fs.writeFileSync(path.join(DIST, 'update.json'), JSON.stringify(update, null, 2));
console.log(`[ota] 完成：dist-harmony/update.json  id=${update.id}  runtimeVersion=${runtimeVersion}`);
