# desktop — MonkeyCode 本地桌面客户端(Tauri 壳)

单引擎架构:壳(Rust)承载 UI(`ui/` React SPA,构建产物随壳分发)与
全部平台服务(百智云/云端任务/文件浏览/上传/浏览器扩展桥),引擎
**ohmyagent** 是壳拉起的 stdio JSON-RPC 子进程(独立上游仓库,不 fork,
版本经仓库根 agent/ submodule 钉死)。

分层、契约(帧词汇/能力/IPC/配置所有权/会话状态机)、浏览器桥与
上游缺口清单见 **[ARCHITECTURE.md](./ARCHITECTURE.md)**(权威文档)。

## 构建与运行

前置:Rust 工具链、Node 22、Go 1.26+(编译引擎)、Linux 需 webkit2gtk。

```bash
# 引擎源码位置(独立仓库)
export OHMYAGENT_SRC=~/dev/chaitin/ai/monkeycode/ohmyagent

cd ui && npm ci && npm run build   # 生成 uidist(cargo build 的前置)
cd .. && cargo build && ./target/debug/monkeycode-desktop

# HMR 开发(devUrl overlay)
npx tauri dev --config tauri.dev.conf.json

# 测试(含 ohmy 假 LLM E2E、浏览器桥假扩展、MCP 冒烟；E2E 不从 PATH 猜版本)
MC_OHMYAGENT_BIN=$OHMYAGENT_SRC/bin/ohmyagent cargo test
cd ui && npm test
```

开发运行找不到引擎时,壳按 `MC_OHMYAGENT_BIN` → 应用同目录 → PATH →
`~/.local/bin` 兜底查找。

## 打包

```bash
make macos            # universal .app/.dmg(在 Mac 上执行)
make macos-release    # + 签名 updater 产物(需 TAURI_SIGNING_PRIVATE_KEY)
make windows          # NSIS 安装包(在 Windows 上执行;或走 CI)
```

引擎 sidecar 由 make 从 `OHMYAGENT_SRC` 编译;externalBin 在基础 tauri
配置中,缺二进制打包直接失败。CI:desktop-{macos,windows,win7}.yml
(win7 通道用 go-win7 补丁工具链 + 固定版 WebView2)。

## 浏览器扩展

`../browser-extension/` 随包分发(设置页引导加载);扩展经
`ws://127.0.0.1:{7440-7449}/ext` 连壳内桥,配对码在设置页展示。
browser_* 工具经壳内 MCP server 暴露给引擎；每条 MCP transport 有独立
浏览器现场和标签页归属，不同 transport 可并行，同一 transport 内按调用
顺序执行。该隔离只依赖标准 `Mcp-Session-Id`，不修改 Agent。
