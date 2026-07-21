# mc-desktop 架构

> 本文是边界与契约的权威定义。新功能动手前先在这里找"该放哪";
> 需要打破契约时先改本文再改代码。

## 总览

```
┌───────────────────────────────────────────────┐
│  ui/  (React SPA,构建产物 uidist/ 随壳分发)    │
│  只经 Tauri IPC 与壳对话:invoke 上行 + 事件下行 │
└──────────────────────┬────────────────────────┘
                       │ Tauri IPC
┌──────────────────────▼────────────────────────┐
│  src/  (Rust 壳)                               │
│  main.rs     宿主:窗口/托盘/桌宠/更新/生命周期  │
│  config.rs   配置权威 + 引擎配置物化(纯函数)    │
│  driver/     引擎驱动层                        │
│    frame.rs    Frame 词汇唯一定义(契约 1)      │
│    mod.rs      DriverHost + Caps + 命令层守卫   │
│    ohmy.rs     ohmyagent 适配(stdio JSON-RPC)  │
│  browser/    浏览器扩展桥 + MCP server          │
│  repo.rs uploads.rs  壳原生服务(文件/上传)     │
│  baizhi/     平台服务(百智云/云端)             │
└──────┬──────────────────────┬─────────────────┘
       │ spawn + stdio JSON-RPC │ MCP streamable-http(loopback)
┌──────▼────────┐       ┌──────▲────────┐      ┌─────────────┐
│ ohmyagent      │──────▶│ 壳内 MCP      │      │ 浏览器扩展   │
│ (上游依赖,     │ 工具调用│ (browser_*)   │◀────▶│ (MV3,WS /ext)│
│  零改动接入)   │       └───────────────┘ CDP  └─────────────┘
└────────────────┘
```

职责铁律:
- **UI 不建立任何网络连接**,不知道查询由谁执行。
- **driver 只做协议翻译**,不做策略;产帧必须经 frame.rs 构造器。
- **壳原生服务(repo/uploads/baizhi/browser)与引擎解耦**;引擎经 MCP
  消费浏览器工具,不感知桥的存在。
- **引擎是可替换子进程**:ohmyagent 是不 fork 的上游,版本经 CI 的
  OHMYAGENT_REF 钉死;壳按 system/ready 的 capabilities 做版本握手,
  能力缺口自动回退(如 switch RPC → destroy+resume)。

## 契约 1:帧词汇(Frame)

下行流的唯一词汇,两方对表:

| 角色 | 位置 |
|---|---|
| 产帧(壳,引擎事件归一化) | src/driver/frame.rs(唯一入口,禁手拼 JSON) |
| 消费(UI) | ui/src/types.ts + reduce.ts |

帧结构 `{type, kind?, data?(base64 JSON), timestamp(ms), seq}`。
类型:`task-started/ended/error`、`user-input`、`permission-req/resolved`、
`reply-question`、`task-running`(kind=`acp_event` 载 sessionUpdate;
kind=`acp_ask_user_question` 载提问卡)。
sessionUpdate:`agent_message_chunk/agent_thought_chunk/tool_call/
tool_call_update(含 progress 子代理 feed 与 failed 终态)/plan/usage_update/
llm_call_retry/compact_status/model_update/permission_mode_update`。

改词汇的顺序:frame.rs 与 types.ts 同一 PR 内同步,
reduce.test.ts 补对应归约断言。云端管道帧(ping/cursor/call-response)
是传输层词汇,不属对话流(遗留:归属待正式定义,见审计清单)。

## 契约 2:能力模型(Caps)

`driver/mod.rs::Caps` 是引擎能力的单一事实来源
(browser_ext/usage_update/perm_remember/attachments)。
能力是渐进的:上游补齐即翻位(如 usage_update 待上游按次出 usage)。

- **强制点唯一在命令层**;driver 实现内不得再各自硬编码能力错误。
- UI 经 `engine_caps` 读取降级(caps 未加载时按"不支持"渲染,不闪现)。

## 契约 3:IPC 规约

- 命令命名 `domain_verb`(session_open/baizhi_login/browser_status…);
  新命令三处同步登记:main.rs invoke_handler、build.rs、tauri.conf.json capability。
- 事件命名 `channel:{id}`:`frames:{sid}`、`conn-status:{sid}`、
  `ws-msg:{pipe}`、`ws-closed:{pipe}`;全局事件 `session-event`、`engine-crashed`。
- **监听先于命令**:壳会在命令处理中同步 emit(回放、管道首帧),
  Tauri 事件不排队,监听未注册即丢。UI 侧必须 `await listenAsync(...)`
  完成后再 invoke;需要壳生成 id 的场景改为 UI 生成 id 先注册。
- 高频帧壳侧 ~30ms 批量后 emit;UI 侧 rAF 批量归约。
- `Conn.send` 语义:resolve(false)=发送失败,调用方保留输入供重试。

## 契约 4:配置所有权

`DesktopConfig`(config.json)是唯一权威;引擎配置是它的**纯函数物化**,
在引擎(重)启时重写:`app_config_dir/ohmyagent/{settings,mcp}.json`
(经 OHMYAGENT_CONFIG_DIR 注入引擎,桌面版私有目录,不碰用户全局
~/.ohmyagent;mcp.json 含壳注入的 mc-browser 内置条目,URL/Bearer
进程级新发)。
壳自有偏好(桌宠)走 save_config_json,只写权威、不触发物化。

数据归属:

| 数据 | 权威 |
|---|---|
| 引擎模型上下文 | app_config_dir/ohmyagent/sessions/<engine_id>/messages.jsonl |
| 会话索引/标题/归档/**帧日志**/engine_id 别名 | 壳 sidecar:app_config_dir/ohmy-sessions/<sid>/ |
| 子代理子会话(壳侧实体,仅回放) | 同上(sidecar 带 parent) |
| 附件 | <workdir>/.mc-agent/uploads(历史目录约定,保持兼容) |
| 百智云/云端凭证 | app_config_dir/*-cookies.json(双罐,互不牵连) |
| 浏览器扩展配对凭据 | app_config_dir/ext-auth.json |

历史妥协已退出:上游 OHMYAGENT_CONFIG_DIR(969311a)落地后配置随
app_config_dir 走,首启自动迁移旧接管目录的 sessions。
(当年**不可**用覆盖 HOME 隔离的原因仍成立:bash 工具会把错误 HOME
泄给用户命令——env 注入是正解。)

引擎 id 与壳 sid 解耦:壳 sid 是目录/UI 通道的稳定标识;engine_id 是
可替换属性(空会话无法 resume 时 destroy+全新 create 换绑),出站 RPC
映射、入站 shell_sid_of 反查、sidecar 持久化。

## 契约 5:会话状态机

状态词汇(Rust `frame::SessionStatus` ↔ TS `types.SessionStatus`):
`created → running → finished | interrupted | error`
- `created` = 新建未运行,**不是 finished**(否则侧栏/桌宠按完成渲染)。
- `interrupted` = 用户取消,**不是完成**(桌宠不庆祝、侧栏不打勾)。
- `waiting_ask` 是运行时叠加位(有待答复的审批/提问),不落盘。
- 轮次帧序(驱动本地先行,不依赖引擎事件时序):
  `user-input → task-started → …engine 事件… → [task-error] → task-ended`。
- **和解原则:引擎应答是确认,不是前提。** 引擎停止/崩溃/取消无应答时,
  驱动本地补收尾(未闭合工具 failed 帧 → task-error → task-ended,
  状态落 interrupted,挂起审批/提问一并失效);引擎迟到的 turn/stopped
  被 running 幂等守卫吞掉。没有这条,会话会永久卡"执行中"。

## 浏览器扩展桥(browser/)

自 mc-agent 迁入的壳原生服务(Go 版在 git 历史 e8666a8 前的
agent/internal/browser/)。扩展side 契约对表 browser-extension/src/protocol.ts,
**扩展零改动**:`ws://127.0.0.1:{7440-7449}/ext`、hello/token/一次性配对码、
Op/Ev/错误码、proto:1、20s ping。

- 9 个 browser_* 工具经壳内 MCP streamable-http server 暴露给引擎
  (Bearer 鉴权;手写最小面:POST json 应答/通知 202/GET 405)。
- **单一共享浏览器会话**(与 mc-agent 按 agent 会话隔离标签页不同):
  MCP 工具调用不带会话身份,桌面单用户下可接受;handoff 队列归全局。
- 错误码→中文可行动文案是产品契约(模型行为依赖),改动需过 e2e 断言。

## 引擎监督

壳监视引擎进程(stdout EOF);非 stop() 引发的退出 → 本地和解运行中
会话(契约 5)→ 全局事件 `engine-crashed {engine, detail, log_tail}`
→ UI 横幅 + `engine_restart` 一键重启。引擎日志:app_config_dir/ohmyagent.log。

## 已知上游缺口(ohmyagent)

协议缺口与对应的壳侧变通,上游补齐后应删壳侧实现:
permission remember(现壳记忆集自动应答)、sendMessage 附件
(现 [图片] 路径文本约定)、上下文用量(壳侧已就绪:model_done 携带
{"usage":{input_tokens,cache_*}} 即点亮上下文环;turn/stopped 的整轮
累计对环语义虚高,不用)、每模型独立凭据
(现同 configKey 冲突跳过)、stdio 会话索引(现 sidecar 权威)、
工具错误不发 tool_result(壳轮次收尾补 failed 帧)、子代理事件无父归属
(壳启发式认领 + 物化子会话)、空会话 resume 不容忍(壳 engine_id 换绑)。
已补齐:OHMYAGENT_CONFIG_DIR(私有目录,969311a)、子代理权限实时
继承父模式(同批,壳撤销"空闲切模式一律重建"变通,恢复原生 switchMode)。

## 开发与构建产物

uidist/ 是纯生成物不入库;壳静态页与 webfonts 在 ui/public/。
引擎 sidecar 来自独立 ohmyagent 仓库:本地打包 `export OHMYAGENT_SRC=...`,
CI 按 OHMYAGENT_REF 钉死;externalBin 在基础 tauri 配置——缺二进制打包
直接失败,不存在"包里没引擎"的静默。

```bash
cd ui && npm run build      # 生成 uidist(cargo build 的前置)
npx tauri dev --config tauri.dev.conf.json   # HMR 开发
cargo test                  # baizhi 假服务端 + 浏览器桥假扩展 + MCP 冒烟
                            # + ohmy 假 LLM E2E(MC_OHMYAGENT_BIN 启用)
```
