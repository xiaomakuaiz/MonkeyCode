# mc-desktop — MonkeyCode 本地桌面客户端(Tauri 壳)

职责边界:**壳持有应用配置与宿主事务,agent 内核只是壳拉起的子进程**。

- 配置(模型列表 + MCP 服务器)存于壳的应用配置目录(`config.json`/`models.json`/`mcp.json`,0600);设置页在主窗口内切换(单窗口体验,首启才独立开窗),保存即重启内核生效
- 内核经环境变量注入配置(`MC_AGENT_MODELS`/`MC_AGENT_MCP_CONFIG` 指向壳写的清单;不走 argv,避免泄漏进 ps),内核零管理职责;项目级 `.mc-agent/mcp.json` 仍随仓库生效
- 首启无配置直接进设置向导,全程不碰终端;托盘菜单"设置"随时可改
- 对话业务与 UI 在 Go 内核(`agent/`),二者经 localhost WS 帧协议解耦

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

## 进程生命周期

- 壳启动 → spawn `mc-agent serve --addr 127.0.0.1:<随机端口> --token <随机> --watch-stdin`,15 秒内等待就绪,失败则打开错误页(不静默退出);
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
- 自更新(壳与内核独立更新);macOS/Windows 构建与签名(内核作为 sidecar 捆绑进安装包);
- OAuth 登录(系统浏览器 + 深链,内核侧 `mc-agent login` 已就绪,待后端端点)。
