# mc-agent — MonkeyCode 本地 Agent 内核

自研编码 agent 内核(M1 headless CLI + M2 localhost WS 宿主)。直接在本机工作区执行编码任务:自主读代码、改文件、跑命令、验证结果,全程流式输出,支持会话恢复。

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

`provider` 支持 `anthropic`(Anthropic Messages 协议)、`openai`(Chat Completions 协议,兼容多数国产模型网关)和 `openai_responses`(OpenAI Responses 协议,网关前缀缓存更友好)。

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

# worktree 隔离模式(工作区须为 git 仓库)
mc-agent run --worktree -p "..."   # 改动发生在独立 git worktree,原仓库不动
mc-agent worktree list             # 列出隔离工作区
mc-agent worktree diff <会话ID>    # 审查改动
mc-agent worktree apply <会话ID>   # 应用回原仓库(不产生提交)
mc-agent worktree drop <会话ID>    # 丢弃全部改动
```

### 权限模型

本地没有沙箱兜底,默认策略:

- 只读操作(读文件/搜索/git 查询)自动放行;
- 写文件、编辑、未知 bash 命令 → 终端询问(y/n/a 始终允许/d 始终拒绝);
- 危险命令(`sudo`、`rm -rf /` 等)直接拒绝;
- `--allow write_file --allow edit_file` 预授权指定工具;`--yolo` 全部放行(仅限受信环境/eval);
- 审批时选「此项目永久」会把规则写入 `<项目>/.mc-agent/permissions.json`,后续会话直接生效(可手动编辑该文件的 `allow`/`deny` 列表)。

文件类操作强制限制在工作区目录内(含 bash 的 cd 越界拉回)。

## MCP(扩展工具)

配置 MCP server(格式与 Claude Code/opencode 同构),其工具会自动注入 agent:

```jsonc
// ~/.config/mc-agent/mcp.json(全局)或 <项目>/.mc-agent/mcp.json(项目级,覆盖全局)
{
  "mcpServers": {
    "context7":   { "url": "https://mcp.context7.com/mcp", "headers": {"Authorization": "Bearer xxx"} },
    "playwright": { "command": "npx", "args": ["@playwright/mcp"], "env": {} }
  }
}
```

```bash
mc-agent mcp list          # 连接并列出各 server 的工具与连接状态
```

- 工具名命名空间化为 `mcp__<server>__<tool>`,避免冲突;
- 传输支持 stdio(`command`)与 Streamable HTTP(`url`);
- 权限:MCP 工具默认走审批,仅 server 声明 `readOnlyHint` 的工具自动放行;
  `--allow mcp__<server>__<tool>` 可预授权;
- 单个 server 连接失败只告警跳过,不阻塞启动;连接随会话建立与关闭;
- MCP 工具返回的图片(如浏览器类 MCP 的截图)会转为图片块送入视觉模型。

## 浏览器控制(操作用户真实浏览器)

serve/桌面模式内置浏览器控制:安装 **MonkeyCode 浏览器扩展**(仓库
`browser-extension/`,Chrome/Edge)并配对后,agent 获得 `browser_` 工具集,
在用户日常使用的浏览器里打开网页、点击、输入、截图——**共享登录态**,无需
Node/Playwright 依赖。

架构:扩展是"带鉴权的 chrome.debugger 哑代理"(WS 连内核
`--ext-addr`,默认 127.0.0.1:7440,被占自动顺延),快照/元素定位/键鼠事件等
语义全部在内核实现。

- **配对**:内核每次启动生成一次性配对码(设置页「浏览器」分类展示),填入
  扩展 options 一次即长期配对(凭据存数据目录 `ext-auth.json`,0600);
- **工具**:`browser_navigate / browser_snapshot / browser_take_screenshot /
  browser_click / browser_type / browser_select_option / browser_press_key /
  browser_scroll / browser_tabs`;快照返回带编号(e1、e2...)的可交互元素列表,
  交互按编号定位;
- **权限**:快照/截图/滚动/标签页列表自动放行;导航/点击/输入等走审批,且
  整类共用一次「记住」(不会每次点击都弹窗);
- **标签页边界**:agent 默认只操作自己新开的标签页;操作用户已打开的页面
  需用户点扩展图标主动「交给 agent」,随时可收回;操作中的标签页顶部会显示
  Chrome 自带的调试提示条(无法隐藏),点其「取消」即断开控制;
- CLI(`mc-agent -p`)模式不注册浏览器工具;`serve --no-browser` 可整体禁用。

## 技能(Skills)

技能 = 一个含 `SKILL.md` 的目录,注入系统提示作为按需知识索引(agent 相关任务时自行 `read_file` 文档),来源三级、同名按 项目 > 全局 > 平台 覆盖:

```
<项目>/.mc-agent/skills/<name>/SKILL.md     # 项目技能(随仓库走)
~/.config/mc-agent/skills/<name>/SKILL.md   # 全局技能(个人积累)
# 平台技能:mc-agent login 后由 MonkeyCode 平台下发,缓存于 ~/.cache/mc-agent/platform/
```

`SKILL.md` 支持可选 frontmatter,缺省取目录名与正文首段:

```markdown
---
name: deploy
description: 部署到测试环境的完整流程
---
# 正文:步骤、脚本用法、注意事项……
```

```bash
mc-agent skills            # 列出当前可用技能与来源
```

全局/平台技能目录对 `read_file` 只读放行(写与编辑仍严格限定工作区)。

## 子代理(task 工具)

主 agent 可把开放式的探索/检索任务(如"找出鉴权逻辑在哪、怎么工作")委托给只读子代理:子代理在**独立上下文**里用 read_file/grep/glob/git 探索,只把结论返回主上下文——翻阅的大量文件内容不挤占主任务上下文。子代理无 bash/写/编辑能力、不可再派子代理,故整体只读、自动放行无需审批;用量计入会话累计。

子代理过程**全程可观测**,两层结构:

- **进度通道**:子代理每一步工具调用实时外显,挂在 task 调用卡片下(CLI 缩进 `↳ ✓ 读取 auth.go`,UI 嵌套渲染);这是通用原语——bash 长命令的最新输出行也经同一通道外显;
- **子会话**:子代理完整帧流落盘为真实子会话(`mc-agent sessions --all` 可见,列表默认隐藏),可独立回放;serve 模式下 UI 点 task 卡片的"查看子会话"即可实时跟看或事后复盘。

## serve 模式(WS 宿主 + 浏览器界面)

```bash
mc-agent serve                # 默认 127.0.0.1:7439,每次启动随机 token
mc-agent serve --token xxx    # 固定 token(桌面壳托管时用)
```

多模型:宿主(桌面壳)可经 `MC_AGENT_MODELS=<清单.json>` 下发模型列表(`[{name, provider, base_url, api_key, model, default}]`),内核只消费不管理。每个会话创建时可选模型,会话中可随时切换(`session_set_model`,轮次间生效;消息历史为归一化格式,跨 provider 续聊安全)。无清单时退回单配置。

启动后终端会打印界面地址(形如 `http://127.0.0.1:7439/#<token>`),浏览器打开即可:创建会话(选工作区,可选 worktree 隔离)→ 对话(Markdown 渲染)→ 流式输出/工具过程/计划 → **写操作在页面上弹审批卡片**(允许/本会话始终/此项目永久/拒绝)。

页面顶部「改动」标签页展示本轮修改的文件(A/M/D),点击查看着色的 unified diff。

界面是 `ui/` 下的 React 工程(Vite 单文件构建,产物 `cmd/mc-agent/uidist/index.html` 入库,`go build` 不依赖 node);改 UI 后:

```bash
cd ui && npm install && npm run build   # 重新生成 uidist,再编译内核生效
```

协议(桌面客户端/IDE 插件对接同一套):

- `GET /healthz`;`GET/POST /api/sessions`(Bearer token);
- `WS /ws?session=<id>&token=<t>`:下行为帧序列(先回放历史再实时);上行 `user-input` / `user-cancel` / `permission-resp`;
- `call`/`call-response`(只读同步查询,不进事件日志):`repo_file_list` / `repo_read_file` / `repo_file_changes` / `repo_file_diff`,供 UI 文件浏览与 diff;
- 安全:仅绑 loopback、随机 token、WS 同源 Origin 校验、慢消费者断开重连回放。

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
internal/loop     主循环:LLM ↔ 工具,中断/恢复/步数上限,上下文压缩(阈值/溢出触发)
internal/provider anthropic + openai 客户端,SSE 流式,tool-call 归一化与修复,退避重试
internal/tools    read/write/edit/bash/grep/glob/git/todo,工作区边界强制
internal/mcp      MCP 客户端:stdio/HTTP 传输,工具适配为内核工具(命名空间化)
internal/workspace git worktree 隔离(create/diff/apply/drop)
internal/repo     只读文件浏览与 diff 查询(call/call-response 后端)
internal/policy   权限规则引擎(工具×路径×命令,allow/deny/ask)
internal/contextmgr 系统提示装配(项目规则 AGENTS.md/CLAUDE.md、仓库树摘要)
internal/session  JSONL 事件日志 + 消息快照,resume
internal/frame    流式帧协议(与云端对齐)
```
