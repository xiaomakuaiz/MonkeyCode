# mc-desktop — MonkeyCode 本地桌面客户端(Tauri 壳)

职责边界:**壳是纯宿主——持有应用配置与宿主事务,不渲染任何业务界面**;
agent 内核只是壳拉起的子进程,**全部产品 UI(含设置视图)在内核的 React 应用**(`agent/ui/`)。

- 配置(模型列表 + MCP 服务器)存于壳的应用配置目录(`config.json`/`models.json`/`mcp.json`,0600);
  **所有权在壳、渲染在内核 UI**:设置视图经 Tauri IPC `get_config`/`save_config` 读写,保存即重启内核生效。
  壳对配置内容零字段知识(原样透传),表单校验在设置视图、权威校验在内核
- 内核经环境变量注入配置(`MC_AGENT_MODELS`/`MC_AGENT_MCP_CONFIG` 指向壳写的清单;不走 argv,避免泄漏进 ps),内核零管理职责;项目级 `.mc-agent/mcp.json` 仍随仓库生效
- **壳无条件拉起内核**:无配置时写出空清单,内核以零模型模式启动(服务与 UI 照常起,建会话前引导配置),
  首启向导即内核 UI 的设置视图;坏配置同样不致死(内核降级零模型 + stderr 警告),
  壳的错误页只兜内核起不来的场景(二进制缺失等安装级故障)
- 托盘菜单"设置"与内核 UI 的 ⚙ 按钮(`open_settings_window` 命令)都打开独立设置窗口
  (label `settings`,加载同一内核 UI 的 `?view=settings` 路由;保存后随内核重启换新令牌 URL)
- 对话业务与 UI 在 Go 内核(`agent/`),二者经 localhost WS 帧协议解耦;内核 `/healthz` 外显版本号

## 构建与运行

前置:Rust 工具链、Linux 需 webkit2gtk;先安装内核(`agent/` 下 `make install`)。模型配置在应用内完成,无需命令行。

```bash
cd mc-desktop
cargo build --release
./target/release/mc-desktop
```

macOS 分发包(在 Mac 上,universal .app/.dmg,内核 sidecar 打入):

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin   # 一次性
make macos    # 产物在 target/universal-apple-darwin/release/bundle/dmg/
```

CI 的 desktop-macos.yml 走同一个 make 入口(push 自动构建,产物在 Actions Artifacts)。
包未签名:同事首次打开需 右键→打开;提示"已损坏"时 `xattr -cr /Applications/MonkeyCode.app`。

内核二进制查找顺序:`MC_AGENT_BIN` 环境变量 → 应用同目录 → PATH(含 `~/.local/bin`)。

## 自动更新与发布

壳内置 tauri-plugin-updater:启动 5 秒后 + 托盘"检查更新"菜单,拉取 OSS 更新清单,
版本号与本地**不一致**即弹窗询问,确认后下载(minisign 验签)安装并自动重启。
macOS 原地替换 .app,未签名包不受影响(自更新下载无 quarantine 属性,不触发 Gatekeeper);
Windows 静默跑 NSIS 安装器(壳先经 updater 的 `on_before_exit` 钩子回收内核进程,
否则 mc-agent.exe 占用文件会导致安装失败)。

三条更新通道各自独立清单(`public/desktop/` 下),由对应平台的发布构建产出,发布互不协调:

| 通道 | 清单 | 产出 |
|---|---|---|
| macOS | `latest.json` | desktop-macos.yml(`make macos-release`) |
| Windows | `latest-windows.json` | desktop-windows.yml |
| Win7 | `latest-win7.json` | desktop-win7.yml |

版本号格式 **`YYMMDDNN`**(日期 + 两位序号,如 26071401),内部以 semver 主版本位承载
(`26071401.0.0`),`tauri.conf.json` 与 `Cargo.toml` 两处保持一致。

发布流程(CI 出产物,人工上传 OSS):

1. 把 `tauri.conf.json` + `Cargo.toml` 的版本改为当天新序号(如 `26071502.0.0`),push;
2. 三条 desktop CI 在配置了 `TAURI_SIGNING_PRIVATE_KEY` secret 时走发布构建,
   Artifacts 里多出 `updater/` 目录:带版本文件名的更新包 + 对应清单;
3. 上传 OSS `public/desktop/`:**先传包,再覆盖清单**(顺序保证客户端不会拉到不存在的包)。
   各平台可独立发布,只传自己通道的包和清单即可。

签名密钥:`npx @tauri-apps/cli signer generate` 生成,公钥在 `tauri.conf.json`,私钥在
GitHub secret `TAURI_SIGNING_PRIVATE_KEY`(丢失则无法再发更新,老用户需手动重装)。
本地联调:`MC_UPDATE_MANIFEST=http://127.0.0.1:8000/latest.json ./target/debug/mc-desktop`
可覆盖清单地址(http 仅 debug 构建放行)。

完整链路人工验证:装当前版,OSS 放新版包 + 清单,启动应弹"发现新版本",确认后自动重启为新版。
历史遗留:2607 早期的 Windows 安装烧的端点还是 `latest.json`(当时无 Windows 条目,从未能自动更新),
需手动重装一次才能进入 `latest-windows.json` 新通道。

## 进程生命周期

- 壳启动 → spawn `mc-agent serve --addr 127.0.0.1:<端口> --token <随机> --watch-stdin`,15 秒内等待就绪,失败则打开错误页(不静默退出);
- 端口首次分配后持久化(配置目录 `port` 文件)并跨启动复用:localStorage 按 origin(含端口)隔离,
  端口固定 UI 本地偏好(主题/分组折叠)才能保留;被占用时才换新端口(偏好随之重置一次)。
  保存设置重启内核时**先停旧再起新**(同端口复用的前提);

- 壳持有内核 stdin 管道:**壳以任何方式退出(含被 SIGKILL)都会关闭管道,内核随之退出**,不留孤儿进程;正常退出路径额外主动 kill。

## 托盘常驻

内核正常运行时,**关窗只隐藏窗口**,任务继续在内核执行;托盘左键单击或菜单"显示窗口"恢复,菜单"退出 MonkeyCode"才真正退出(内核随之回收)。降级逻辑:托盘创建失败(无 StatusNotifier 宿主的桌面环境)或内核启动失败的错误页,关窗直接退出,不会出现"藏起来找不回"的僵尸窗口。

## 无头/CI 环境冒烟

WebKitGTK 初始化依赖 DBus 会话总线,纯 Xvfb 下会阻塞,需:

```bash
NO_AT_BRIDGE=1 xvfb-run -a dbus-run-session -- ./target/debug/mc-desktop
```

## 路线图(v0 之后)

- ~~托盘常驻 + 关窗不退出~~(已交付);~~独立 React UI 替换内嵌调试 UI~~(已交付,见 `agent/ui/`);
- ~~自更新(壳整包,内核随包)~~(已交付,见上节);内核独立热更新(清单加 kernel 段,免重启壳);
- macOS/Windows 构建与签名(内核作为 sidecar 捆绑进安装包);
- OAuth 登录(系统浏览器 + 深链,内核侧 `mc-agent login` 已就绪,待后端端点)。
