# MonkeyCode 鸿蒙轨（RNOH）

主轨 `../mobile` 是 Expo 56 / RN 0.85（iOS + Android）。鸿蒙官方 RNOH 目前最高适配 **RN 0.82**
（npm `@react-native-oh/react-native-harmony`，本工程用 `0.82.31` / RN 0.82.1 / React 19.1），
无法直接编译主轨工程，故采用**双轨**：

- **业务代码 100% 共享**：页面（`../mobile/app`）与逻辑（`../mobile/src`）直接引用，零复制；
- **expo-\* 等主轨专属依赖** → `shims/` 鸿蒙实现（babel `module-resolver` 重定向，import 名不变）；
- **社区原生库** → `@react-native-ohos/*` 官方鸿蒙适配版（RNOH metro 配置按包内 `harmony.alias`
  字段自动重定向）；
- **自研原生能力** → `harmony/entry/src/main/ets/turbomodule/`（语音 PCM 流、Cookie、分享、
  相册、图片压缩、OTA），JS spec 在 `specs/`。

## 目录速览

```
mobile-harmony/
├── index.js                  # appKey 'MonkeyCode'（须与 Index.ets 一致）
├── src/App.tsx               # 注册路由表 → 复用主轨 RootLayout
├── shims/                    # expo-router / expo-* / keyboard-controller / 语音 等鸿蒙替代
├── specs/                    # 自研 TurboModule 的 JS spec（codegen）
├── types/                    # 仅 tsc 用的类型补充（运行时无关）
├── scripts/export-ota.mjs    # 产出 dist-harmony/{hermes_bundle.hbc,update.json}
└── harmony/                  # DevEco 工程（ArkTS 壳 + 自研模块）
```

## macOS 上手（内测）

### 1. 环境

1. 安装 **DevEco Studio 6.0.1**（RNOH 0.82.31 配套要求 6.0.1.245SP4；HarmonyOS SDK
   6.0.1，最低 API 20）。
2. 环境变量（加进 `~/.zshrc`）：
   ```sh
   export DEVECO_SDK_HOME="/Applications/DevEco-Studio.app/Contents/sdk"
   # hdc 命令行（按 SDK 实际版本路径调整）：
   export PATH="$DEVECO_SDK_HOME/default/openharmony/toolchains:$PATH"
   ```
3. 真机要求 HarmonyOS NEXT（API 20 ROM，如 Mate 60 系列 206.x）；或用 DevEco 自带模拟器。

### 2. 安装与构建

```sh
cd mobile-harmony
npm install                       # JS 依赖（含 RNOH har、hvigor 插件）

# 用 DevEco Studio 打开 mobile-harmony/harmony 目录
#  - 首次会跑 ohpm install（解压 ~800MB 的 RNOH har，耐心等完）
#  - Sync 阶段 hvigor 插件自动执行：codegen-harmony（specs/ 胶水）、
#    link-harmony（autolinking：生成 RNOHPackagesFactory.* / autolinking.cmake、
#    回写三方库 har 依赖）、hdc rport tcp:8081
#  - File → Project Structure → Signing Configs → 勾选 Automatically generate signature
```

### 3. 运行（调试，连 Metro）

```sh
npm start                          # Metro :8081
# DevEco 里 Run 'entry'（debug 构建自动连 Metro；如端口没通：hdc rport tcp:8081 tcp:8081）
```

### 4. Release / 内测包

```sh
npm run bundle:harmony             # 产出 rawfile/hermes_bundle.hbc（hvigor release 构建也会自动执行）
# DevEco：Build → Hap(s)，产物用内测签名分发
```

### 5. OTA 发布

```sh
npm run ota:export                 # dist-harmony/{hermes_bundle.hbc, update.json}
# mobile/ota-server 已带 /harmony/ 通道（默认读 ../mobile-harmony/dist-harmony，
# 可用 OTA_HARMONY_DIST 覆盖）；也可把 dist-harmony 直接静态托管到 OSS。
# 原生新包提示：ota-server/native-release.json 的 "harmony" 条目。
```

加载顺序（`harmony/.../pages/Index.ets`）：Metro（仅 debug）→ 沙箱 OTA 包
（`files/ota/hermes_bundle.hbc`）→ 内置 rawfile 包。`reloadAsync` 用
`appRecovery.restartApp()` 重启生效。

## 发版清单

1. `../mobile/app.json` 的 `expo.version`（= OTA runtimeVersion / Constants 版本）与
   `harmony/AppScope/app.json5` 的 `versionName/versionCode` **三处同步**；
2. JS-only 改动：`npm run ota:export` + 上传 dist-harmony；
3. 涉原生改动：出新 hap + 更新 native-release.json 的 harmony 条目。

## Linux 侧已验证

- `npm install` ✅
- `npx tsc --noEmit` ✅（0 错误，覆盖共享代码 + shims + specs）
- `npx react-native bundle-harmony --dev` ✅（依赖图完整，bundle + 21 assets）
- `npm run ota:export` ✅（hermes 字节码 + update.json）

## 待真机验证的风险点（按优先级）

| # | 风险 | 现状/兜底 |
|---|------|----------|
| 1 | **DevEco Sync / autolinking / codegen** 首次跑通 | 工程文件按 cli 0.82.31 内置模板手写；报错时对照 `node_modules/@react-native-oh/react-native-harmony-cli/src/init/templates/` |
| 2 | **specs codegen 版本**（package.json `harmony.codegenConfig` 用 v2，与 async-storage 同款） | 若 codegen 报 spec 解析错，把 version 改 1 重试 |
| 3 | **WebView 渲染**（预览/OAuth） | autolinking 应自动注册；若白屏按 [webview 文档](https://gitcode.com/OpenHarmony-RN/usage-docs/raw/master/zh-cn/react-native-webview.md) 在 Index.ets 加 `wrappedCustomRNComponentBuilder` |
| 4 | **登录态 Cookie**：fetch 已 `credentials:'include'`（RNOH 走 ArkWeb Cookie 池）；WS 由 `client.ts` 手动补 Cookie（`MonkeyCodeNative.getCookies`） | 真机验证登录 → 任务流 → 语音 三条 WS 链路 |
| 5 | **NativeModules.RNLiveAudioStream 探测**（bridgeless 的 NativeModules 代理） | 已加 `Platform.OS === 'harmony'` 旁路，shim 内部判空降级 |
| 6 | **ArkTS 模块 API 细节**（ShareKit/photoAccessHelper/ImageKit 签名以 SDK 实际为准） | 单文件小模块，DevEco 编译器会精确指出 |
| 7 | **beta/rc 版三方库**（async-storage 2.3.0-beta.1、image-picker 8.3.0-beta.5、fs 2.22.0-beta.3、clipboard 1.17.0-rc.1、screens 4.9.0-rc.11） | 如有问题可整体回退 0.77 轨配套版（见 usage-docs 各库兼容性表） |
| 8 | **appRecovery.restartApp 重启生效 OTA** | 失败兜底：提示用户手动杀进程重开（冷启动同样生效） |

## 已知降级（与主轨 Android 对齐或暂缺）

- 毛玻璃 → 半透明纯色（Android 本就如此；可换 `@react-native-ohos/blur` 升级）；
- PoW 验证码 sha256 走 @noble 纯 JS（quick-crypto 无鸿蒙版；慢但可用，可后续下沉原生）；
- `react-native-keyboard-controller` → RN 内置 `KeyboardAvoidingView`；
- 文件下载走 XHR 全内存（同主轨 Android，原因相同：原生下载不带会话 Cookie）。
