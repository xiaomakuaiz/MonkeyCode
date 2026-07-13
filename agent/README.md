# mc-agent — MonkeyCode 本地 Agent 内核

自研编码 agent 内核(M1,headless CLI 形态)。直接在本机工作区执行编码任务:自主读代码、改文件、跑命令、验证结果,全程流式输出,支持会话恢复。

设计文档:`docs/superpowers/specs/2026-07-12-local-agent-design.md`

## 安装

需要 Go 1.25+(仅构建时;产物为零依赖单二进制):

```bash
cd agent
make install        # 构建并安装到 ~/.local/bin/mc-agent
```

或手动构建:`make build`(产物在 `bin/mc-agent`),交叉编译六平台:`make cross`。

## 配置

三种方式,优先级 flag > 环境变量 > 配置文件:

```bash
# 写入配置文件(~/.config/mc-agent/config.json,权限 0600)
mc-agent config set \
  --provider anthropic \
  --base-url https://<你的网关>/api/anthropic \
  --api-key sk-xxx \
  --model <模型或路由别名>

mc-agent config get   # 查看(key 打码)
```

环境变量:`MC_AGENT_PROVIDER` / `MC_AGENT_BASE_URL` / `MC_AGENT_API_KEY` / `MC_AGENT_MODEL`,数据目录 `MC_AGENT_DATA_DIR`(默认 `~/.local/share/mc-agent`)。

`provider` 支持 `anthropic`(Anthropic Messages 协议)和 `openai`(Chat Completions 协议,兼容多数国产模型网关)。

## 使用

```bash
# 单任务(在当前目录作为工作区)
mc-agent run -p "修复 calc 包的测试失败"

# 指定工作区
mc-agent run --dir ~/dev/myrepo -p "给 HTTP handler 加上超时中间件"

# 交互式对话
mc-agent chat

# 会话管理
mc-agent sessions                  # 列出历史会话
mc-agent chat --resume <会话ID>    # 恢复会话继续对话
```

### 权限模型

本地没有沙箱兜底,默认策略:

- 只读操作(读文件/搜索/git 查询)自动放行;
- 写文件、编辑、未知 bash 命令 → 终端询问(y/n/a 始终允许/d 始终拒绝);
- 危险命令(`sudo`、`rm -rf /` 等)直接拒绝;
- `--allow write_file --allow edit_file` 预授权指定工具;`--yolo` 全部放行(仅限受信环境/eval)。

文件类操作强制限制在工作区目录内(含 bash 的 cd 越界拉回)。

## 评测(eval)

```bash
mc-agent eval --tasks eval/tasks --report report.json
```

任务定义:`eval/tasks/<名称>/task.json`(`prompt` + `check` 判分命令 + `files/` 工作区夹具),在隔离临时目录执行,退出码 0 视为通过。输出通过率、步数、token 用量。

## 架构位置

本内核是本地版桌面产品的执行核心。对外协议为流式帧
`{type, kind, data(base64), timestamp, seq}`,与云端任务流一致(ACP 风格
session update),会话事件日志(`events.jsonl`)即帧序列——M2 的
`mc-agent serve`(localhost WS 宿主)与桌面 UI 直接消费同一协议。

```
cmd/mc-agent      CLI(run/chat/sessions/config/eval/serve)
internal/loop     主循环:LLM ↔ 工具,中断/恢复/步数上限
internal/provider anthropic + openai 客户端,SSE 流式,tool-call 归一化与修复,退避重试
internal/tools    read/write/edit/bash/grep/glob/git/todo,工作区边界强制
internal/policy   权限规则引擎(工具×路径×命令,allow/deny/ask)
internal/contextmgr 系统提示装配(项目规则 AGENTS.md/CLAUDE.md、仓库树摘要)
internal/session  JSONL 事件日志 + 消息快照,resume
internal/frame    流式帧协议(与云端对齐)
```
