# mc-desktop — MonkeyCode 本地桌面客户端(Tauri 薄壳)

v0 形态:壳只做四件事——生成访问令牌、挑选空闲端口、拉起 `mc-agent serve` 子进程、打开窗口加载内核 UI。业务全部在 Go 内核(`agent/`),二者经 localhost WS 帧协议解耦;后续独立 React UI 可直接替换窗口内容,内核零改动。

## 构建与运行

前置:Rust 工具链、Linux 需 webkit2gtk;先安装内核(`agent/` 下 `make install`)并完成 `mc-agent config set`。

```bash
cd mc-desktop
cargo build --release
./target/release/mc-desktop
```

内核二进制查找顺序:`MC_AGENT_BIN` 环境变量 → 应用同目录 → PATH(含 `~/.local/bin`)。

## 进程生命周期

- 壳启动 → spawn `mc-agent serve --addr 127.0.0.1:<随机端口> --token <随机> --watch-stdin`,15 秒内等待就绪,失败则打开错误页(不静默退出);
- 壳持有内核 stdin 管道:**壳以任何方式退出(含被 SIGKILL)都会关闭管道,内核随之退出**,不留孤儿进程;正常退出路径额外主动 kill。

## 无头/CI 环境冒烟

WebKitGTK 初始化依赖 DBus 会话总线,纯 Xvfb 下会阻塞,需:

```bash
NO_AT_BRIDGE=1 xvfb-run -a dbus-run-session -- ./target/debug/mc-desktop
```

## 路线图(v0 之后)

- 托盘常驻 + 关窗不退出;自更新(壳与内核独立更新);
- macOS/Windows 构建与签名(内核作为 sidecar 捆绑进安装包);
- 独立 React UI 工程替换内嵌调试 UI;OAuth 登录(系统浏览器 + 深链)。
