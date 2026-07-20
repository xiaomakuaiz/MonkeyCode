# mc-desktop 架构

> 本文是边界与契约的权威定义。新功能动手前先在这里找"该放哪";
> 需要打破契约时先改本文再改代码。

## 总览

```
┌───────────────────────────────────────────────┐
│  ui/  (React SPA,构建产物入库到 uidist/)      │
│  只经 Tauri IPC 与壳对话:invoke 上行 + 事件下行 │
└──────────────────────┬────────────────────────┘
                       │ Tauri IPC
┌──────────────────────▼────────────────────────┐
│  src/  (Rust 壳)                               │
│  main.rs     宿主:窗口/托盘/桌宠/更新/生命周期  │
│  config.rs   配置权威 + 各引擎配置物化(纯函数)  │
│  driver/     引擎驱动层                        │
│    frame.rs    Frame 词汇唯一定义(契约 1)      │
│    mod.rs      Engine 分发 + Caps + 命令层守卫  │
│    mc.rs       mc-agent 适配(REST/WS 客户端)   │
│    ohmy.rs     ohmyagent 适配(stdio JSON-RPC)  │
│  repo.rs uploads.rs  壳原生服务(引擎无关)      │
│  baizhi/     平台服务(百智云/云端,引擎无关)    │
└──────┬──────────────────────┬─────────────────┘
       │ spawn + HTTP/WS      │ spawn + stdio JSON-RPC
┌──────▼───────┐       ┌──────▼────────┐
│ mc-agent      │       │ ohmyagent      │
│ (headless,    │       │ (上游依赖,     │
│  本仓 agent/) │       │  零改动接入)   │
└───────────────┘       └────────────────┘
```

职责铁律:
- **UI 不建立任何网络连接**,不知道引擎是谁、查询由谁执行。
- **driver 只做协议翻译**,不做策略;产帧必须经 frame.rs 构造器。
- **壳原生服务(repo/uploads/baizhi)与引擎无关**,切引擎不影响。
- **引擎是可替换子进程**;mc-agent 是本仓内核,ohmyagent 是不 fork 的上游。
- 唯一例外:浏览器扩展桥(/api/browser/*)留在 mc-agent 进程内——
  它给 agent 提供 browser_* 工具,与工具注册深耦合,属引擎能力而非壳服务。

## 契约 1:帧词汇(Frame)

下行流的唯一词汇,三方对表:

| 角色 | 位置 |
|---|---|
| 产帧(mc-agent) | agent/internal/frame/frame.go |
| 产帧(壳,ohmy 归一化) | src/driver/frame.rs(唯一入口,禁手拼 JSON) |
| 消费(UI) | ui/src/types.ts + reduce.ts |

帧结构 `{type, kind?, data?(base64 JSON), timestamp(ms), seq}`。
类型:`task-started/ended/error`、`user-input`、`permission-req/resolved`、
`reply-question`、`task-running`(kind=`acp_event` 载 sessionUpdate;
kind=`acp_ask_user_question` 载提问卡)。
sessionUpdate:`agent_message_chunk/agent_thought_chunk/tool_call/
tool_call_update/plan/usage_update/llm_call_retry/compact_status/
model_update/permission_mode_update`。

改词汇的顺序:frame.go 与 frame.rs 与 types.ts 同一 PR 内同步,
reduce.test.ts 补对应归约断言。

## 契约 2:能力模型(Caps)

`driver/mod.rs::Caps` 是引擎能力的单一事实来源
(browser_ext/usage_update/perm_remember/attachments)。

- **强制点唯一在命令层**(如 kernel_http 检查 browser_ext);
  driver 实现内不得再各自硬编码能力错误。
- UI 经 `engine_caps` 读取降级(caps 未加载时按"不支持"渲染,不闪现)。
- 新引擎 = 新 Caps 条目 + Engine 枚举分支,不改 UI。

## 契约 3:IPC 规约

- 命令命名 `domain_verb`(session_open/baizhi_login/cloud_ws_send…);
  新命令三处同步登记:main.rs invoke_handler、build.rs、tauri.conf.json capability。
- 事件命名 `channel:{id}`:`frames:{sid}`、`conn-status:{sid}`、
  `ws-msg:{pipe}`、`ws-closed:{pipe}`;全局事件 `session-event`、`engine-crashed`。
- **监听先于命令**:壳会在命令处理中同步 emit(回放、管道首帧),
  Tauri 事件不排队,监听未注册即丢。UI 侧必须 `await listenAsync(...)`
  完成后再 invoke(见 client.ts connect/openPipe);需要壳生成 id 的场景
  改为 UI 生成 id 先注册(cloud_ws_open 的 pipe 参数)。
- 高频帧壳侧 ~30ms 批量后 emit;UI 侧 rAF 批量归约。
- `Conn.send` 语义:resolve(false)=发送失败,调用方保留输入供重试。

## 契约 4:配置所有权

`DesktopConfig`(config.json)是唯一权威;所有下游配置是它的**纯函数物化**,
在 save_config / engine_restart 时重写:

| 下游 | 路径 | 消费方 |
|---|---|---|
| models.json / mcp.json | app_config_dir | mc-agent(环境变量注入) |
| settings.json / mcp.json | ~/.ohmyagent(接管式,首次 .bak) | ohmyagent |

引擎会话数据归属:

| 数据 | 权威 |
|---|---|
| mc-agent 会话(meta/events/messages) | ~/.config/mc-agent/sessions(内核自管) |
| ohmyagent 模型上下文 | ~/.ohmyagent/sessions/<sid>/messages.jsonl |
| ohmyagent 会话索引/标题/归档/**帧日志** | 壳 sidecar:app_config_dir/ohmy-sessions/<sid>/ |
| 附件 | <workdir>/.mc-agent/uploads(双引擎共用目录约定) |
| 百智云/云端凭证 | app_config_dir/*-cookies.json(双罐,互不牵连) |

已知妥协:~/.ohmyagent 是与 CLI 共享的全局目录,桌面版声明式接管
(设置页已提示);退出条件 = 上游支持 OHMYAGENT_CONFIG_DIR。
**不可**用覆盖 HOME 隔离——bash 工具会把错误 HOME 泄给用户命令。

## 契约 5:会话状态机

状态词汇(Rust `frame::SessionStatus` ↔ TS `types.SessionStatus`):
`created → running → finished | interrupted | error`
- `created` = 新建未运行,**不是 finished**(否则侧栏/桌宠按完成渲染)。
- `interrupted` = 用户取消,**不是完成**(桌宠不庆祝、侧栏不打勾)。
- `waiting_ask` 是运行时叠加位(有待答复的审批/提问),不落盘。
- 轮次帧序(ohmy 驱动本地先行,不依赖引擎事件时序):
  `user-input → task-started → …engine 事件… → [task-error] → task-ended`。
- **和解原则:引擎应答是确认,不是前提。** 引擎停止/崩溃/取消无应答时,
  驱动本地补收尾(未闭合工具 failed 帧 → task-error → task-ended,
  状态落 interrupted,挂起审批/提问一并失效);引擎迟到的 turn/stopped
  被 running 幂等守卫吞掉。没有这条,会话会永久卡"执行中"。

## 引擎监督

壳监视引擎进程:mc 每 2s try_wait,ohmy 依赖 stdout EOF。
非 stop() 引发的退出 → 全局事件 `engine-crashed {engine, detail, log_tail}`
→ UI 横幅 + `engine_restart` 一键重启(与 save_config 共用
apply_config_and_restart)。引擎日志:app_config_dir/{kernel,ohmyagent}.log。

## 已知上游缺口(ohmyagent)

协议缺口与对应的壳侧变通,上游补齐后应删壳侧实现:
permission remember(现壳记忆集自动应答)、sendMessage 附件
(现 [图片] 路径文本约定)、上下文用量(turn/stopped 已带整轮**累计**
usage,但上下文条语义是"当前占用/预算",累计 input 会虚高——需上游
按次调用出 usage 或直接给 context_tokens,用量条继续隐藏)、
每模型独立凭据(现同 configKey 冲突跳过)、stdio 模式会话索引
(现 sidecar 权威)。
工具错误路径不发 tool_result(错误只进模型消息;壳在轮次收尾对
未闭合 tool_call 补 failed 帧变通)。子代理转发事件不带父归属
(session_id 是子循环随机 id;壳用"运行中且持有未闭合 Agent 工具
的会话"启发式认领,物化为壳侧子会话 + Agent 工具卡 progress feed——
并发多 Agent 时归属可能不准,上游应在转发事件上带 parent_session_id)。
子代理权限顶棚在会话**构建时快照**(switchMode 只改父评估器,热切后
子代理仍按旧模式全拒;壳变通:空闲切模式一律 destroy+重建带新顶棚,
运行中热切仅父生效)。空会话 resume 必失败(messages.jsonl 未生成;
壳变通:改全新 create,壳 sid 不变,engine_id 别名换绑)。
已补齐并接入:session/switchModel、session/switchMode(替代
destroy+resume,模式可运行中切;壳按 system/ready 的 capabilities
做版本握手,旧引擎自动回退 destroy+resume)、mcp headers、compaction 事件。

## 开发与构建产物

uidist/ 是**纯生成物,不入库**(gitignore):壳静态页(pet/error/音效)与
webfonts 属源码,放 ui/public/,构建时 Vite 拷入;emptyOutDir 开启,
每次构建从零输出。打包(tauri build,含 CI 与 make macos/windows)经
beforeBuildCommand 自动构建 UI;直接 cargo build 前需先构建一次 UI。

```bash
cd ui && npm run build      # 生成 uidist(cargo build 的前置)
npx tauri dev --config tauri.dev.conf.json   # HMR 开发(devUrl 仅在此 overlay)
cargo test                  # 含 baizhi 假服务端集成 + ohmy 假 LLM E2E
                            # (MC_OHMYAGENT_BIN 指向二进制启用 E2E)
```
