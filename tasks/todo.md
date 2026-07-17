# M1:mc-agent 内核(headless)实施计划

> 设计依据:`docs/superpowers/specs/2026-07-12-local-agent-design.md`
> 已确认:代码在主仓 `agent/` 目录(独立 Go module);开发/eval 直连 API(百智网关,Anthropic 协议,路由别名 feature/coding → deepseek-v4-pro)。
> M1 完成标准:headless CLI 在真实仓库完成中等复杂度编码任务;eval harness 对首批任务集出基线分。✅ 已达成

## 阶段 0:工程骨架

- [x] `agent/` 目录:独立 Go module(`go.mod`),CGO_ENABLED=0
- [x] 目录结构:`cmd/mc-agent` + `internal/{loop,provider,tools,policy,contextmgr,session,frame,config}`
- [x] 基础设施:slog 不需要(内核输出即帧流)、配置(JSON 文件+环境变量+flag)、cobra CLI 骨架
- [x] CI:`.github/workflows/agent-ci.yml`(vet + test + 六平台交叉编译产物)

## 阶段 1:帧协议 + Provider 层

- [x] `internal/frame`:帧结构对齐云端(type 对齐 consts/task.go;task-running 载荷为 ACP 风格 sessionUpdate,与 Web/移动端渲染层同词汇)+ 单测
- [x] `internal/provider`:Anthropic Messages 流式客户端(自研 SSE 解析:text/thinking/tool_use/signature)+ OpenAI Chat Completions 兼容客户端(reasoning_content、tool_calls delta)
- [x] tool-call 归一化:JSON 修复(代码栅栏/尾逗号/文本包裹提取)+ 解析错误反馈模型重试 + usage 记账;单测覆盖
- [x] 请求重试:指数退避,429/5xx/网络错误可重试,重试事件外显为 llm_call_retry 帧
- [~] 多模型冒烟:网关别名(deepseek-v4-pro)全链路真实验证;GLM/Kimi/Qwen 无可用 key,OpenAI 协议路径以单测(mock SSE)覆盖 → 拿到各家 key 后补冒烟

## 阶段 2:工具层 v1

- [x] `read_file` / `write_file`:行号、分页、大小上限、目录列出
- [x] `edit_file`:精确替换 + 唯一性校验 + 引导性错误 + replace_all
- [x] `bash`:每调用独立进程 + cwd 跨调用保持(标记跟踪)+ 越界拉回 + 进程组终止(unix)/Kill(windows)+ 超时
  - 偏差:未用 creack/pty 常驻 shell(env 不跨调用保持)。M2 若需要交互式/env 保持再引入 pty
- [x] `grep`:系统 rg 优先 + 纯 Go 回退(未嵌入 rg 二进制,嵌入放到打包阶段)
- [x] `glob`(doublestar)/ `git`(只读子命令白名单)/ `todo`(全量替换,外显 plan 帧)
- [x] 工具注册表 + schema:手写 schema map(中文描述可控);偏差:未用 invopop/jsonschema,参数 struct 与 schema 同文件相邻,单一来源程度可接受

## 阶段 3:Policy + Context + Session

- [x] `internal/policy`:只读放行 / 写与未知命令 ask / 危险命令 deny;bash 按命令段白名单;会话内记住决定;--allow 预授权;--yolo
- [x] headless ask:终端 y/n/a/d 交互;非交互模式下 ask 即拒绝(提示 --yolo/--allow)
- [x] `internal/contextmgr`:内置系统提示(含 gofmt 格式化要求——dogfood 教训)+ AGENTS.md/CLAUDE.md 装配 + git 分支 + 仓库树摘要(限深限量)
- [x] `internal/session`:JSONL 事件日志(帧序列)+ messages.json 快照 + meta.json;--resume 续聊;sessions 列表
  - 偏差:未用 SQLite(modernc),JSONL+meta 扫描已满足 M1;会话量大后再上索引

## 阶段 4:Loop 集成 + headless CLI

- [x] `internal/loop`:主循环、流式帧下发、usage_update、步数上限(默认 80)、上下文预算占位(压缩 M3)
- [x] 中断:SIGINT/SIGTERM → context 取消 → 工具进程组终止,会话标记 interrupted 可恢复
- [x] `mc-agent run -p`(--quiet/--dir/--resume)、`mc-agent chat`(REPL)、`sessions`、`config set/get`
- [x] `mc-agent serve` 占位(M2 与桌面端一起交付)

## 阶段 5:eval harness + 基线

- [x] `mc-agent eval`:任务目录(task.json + files/ 夹具)→ 隔离临时 git 仓库执行(yolo)→ check 命令判分 → 通过率/步数/tokens/用时 + JSON 报告
- [x] 首批任务集 3 个:fix-off-by-one(修 bug)、impl-function(按测试实现)、refactor-rename(跨文件重构)
  - 偏差:目标 10~20 个,先交付 3 个覆盖三类任务形态;扩充任务集是纯内容工作,持续补充
- [x] 基线:feature/coding(deepseek-v4-pro)**3/3 通过**(报告 /tmp/eval-baseline.json);多模型分数矩阵待各家 key
- [x] dogfood ≥3 个真实任务(均由 mc-agent 自主完成):
  1. 修复自身 read.go/contextmgr.go 的 lint 警告(发现 gofmt 问题→系统提示已加规则)
  2. 为 internal/frame 编写完整单测(一次通过,gofmt 干净)
  3. 为 internal/session 编写完整单测(一次通过,gofmt 干净)

## Review

**结果**:M1 全部交付。`mc-agent` 已安装到 `~/.local/bin`,配置写入 `~/.config/mc-agent/config.json`(0600,API key 不入仓库)。端到端验证:真实 bug 修复任务(读代码→跑测试→精确编辑→回归→总结)、resume 续聊、事件日志帧格式与云端协议一致、eval 基线 3/3、三平台交叉编译、`go vet`+全部单测通过。

**主要偏差(均已在对应条目标注)**:SQLite→JSONL、pty 常驻 shell→每调用+cwd 跟踪、rg 嵌入→系统 rg+Go 回退、schema 生成库→手写 map、任务集 3/20。皆为降低 M1 复杂度的有意取舍,不阻塞 M2。

**发现的问题与修复**:eval 判分遇 Go VCS stamping(已修:临时区 git init + GOFLAGS=-buildvcs=false);evalResult 用时 defer 不生效(已修:命名返回值);agent 编辑后缩进不规范(已修:系统提示加 gofmt 要求,后续 dogfood 验证有效)。

**遗留(M2)**:serve(localhost WS 宿主)、上下文压缩、Windows ConPTY 实测、权限规则持久化到项目配置、多模型冒烟与分数矩阵、任务集扩充。

---

# M2(进行中):serve 宿主

- [x] `internal/server`:localhost WS 宿主——仅 loopback + 随机 token(REST Bearer / WS query)+ 同源 Origin 校验;REST 会话管理;WS 帧双向流(连接时回放 events.jsonl 再实时,seq 衔接历史);同会话单轮互斥;user-cancel 取消
- [x] 权限审批透传:policy ask → `permission-req` 帧 → UI 审批卡片 → `permission-resp` 回传(带超时);集成测试覆盖拒绝路径
- [x] 内嵌调试 UI(单文件 HTML,go:embed):会话列表/创建、流式对话、工具过程、计划、审批卡片、上下文用量。正式 UI 随桌面壳(Tauri)交付
- [x] 测试:server 集成测试 6 例(鉴权/会话/WS 轮次/重连回放/审批/loopback 强制)全过;真实网关 WS 端到端(含审批批准后文件落盘)验证通过
- [x] 上下文压缩:输入 token 超预算 80% 阈值触发 / 上下文溢出错误触发,全史摘要替换(结构化压缩提示词),compact_status 帧全端可见,--context-budget flag;loop 单测 6 例 + 真实网关小预算验证(压缩后 agent 凭摘要恢复并完成任务)
- [x] Tauri 桌面壳 v0(`mc-desktop/`):拉起内核(随机端口+令牌)、窗口加载内核 UI、stdin 看门狗防孤儿(SIGKILL 壳内核也跟随退出,已验证);托盘/自更新/签名/独立 React UI 列入路线图
- [x] eval 任务集扩充 3→10(跨文件 bug/数据竞争/补测试/CLI 功能/JSON 修复/bash 统计/文档生成),基线 **10/10 通过**(feature/coding)
- [x] worktree 隔离模式:internal/workspace(create/diff/apply/drop,含未跟踪文件)、`--worktree` flag、`mc-agent worktree` 子命令、serve/调试 UI 支持;真实网关端到端验证(隔离执行→原仓库零污染→apply 落回→drop 清理)
- [x] macOS 打包物料:desktop-macos.yml(universal .app/.dmg,内核 sidecar)+ darwin 内核二进制(agent/dist/,本地已构建)
- [x] MCP 客户端(internal/mcp):stdio + Streamable HTTP 传输,tools 适配为内核工具(命名空间化 mcp__server__tool),全局+项目两级配置,只读注解自动放行/其余审批,单点失败不阻塞;mc-agent mcp list 子命令;CLI 与 serve 均接入;单测 6 例(含真实 stdio server 端到端)+ 真实网关模型实调验证
- [x] call/call-response 同步查询 + UI 改动面板/diff 视图:internal/repo(file_list/read_file/file_changes/file_diff,工作区边界强制,未跟踪文件构造全新增 diff),serve 分发(不落日志/只回发起方),调试 UI 改动 Tab + 着色 unified diff;repo 单测 3 例 + server call 测试 + 真实 serve 端到端验证
- [x] 速赢:chat 头部 bug、eval 基线归档、bash env 跨调用保持、权限"此项目永久"持久化、isTerminal 修正
- [~] 平台对接(OAuth 登录/技能规则下发/LLMProxy key):**内核侧完成**(internal/platform + login/logout +
      contextmgr 注入,mock 平台端到端已验证);**后端端点暂缓**(用户决定先不动后端,biz/desktop 实现已回滚,
      端点契约见下方"M2 收尾"节,后端确认后可直接照做)
- [ ] Windows ConPTY 实测(阻塞:需 Windows 机器)、多模型冒烟分数矩阵(阻塞:需 GLM/Kimi/Qwen key)

## M2 收尾:平台对接实施计划(2026-07-13)

> 设计依据:local-agent-design.md §6 登录流 / §3 上下文 / L180 改动清单。
> 侦察结论:后端登录全为 session cookie(无 Bearer 面);LLMProxy 已存在
> (`/v1/messages|chat/completions`,model_api_keys 经 X-Api-Key/Bearer 鉴权,
> `CreateRuntimeAPIKey` 可复用);技能/规则有 agentresource.Resolver 但只在任务
> VM 分发,无桌面拉取端点;内核零平台代码。

### 后端 `biz/desktop/`(已回滚,暂缓——保留端点契约备查)

> 2026-07-13 曾完整实现并测试(miniredis 全链路 4 例),按用户决定回滚。内核按以下契约实现并 mock 验证,
> 后端恢复实施时照此契约即可零改内核:
>
> - `GET /api/v1/desktop/authorize?redirect_uri&state`(session):校验 redirect_uri(monkeycode:// 或
>   loopback http),未登录 302 /login,已登录发一次性 code(建议 Redis TTL 5min)302 回调
> - `POST /api/v1/desktop/token {code}` → `{access_token(mcd_*), token_type, expires_in, user}`
> - `POST /api/v1/desktop/runtime-key {model_id?}`(Bearer mcd_*)→ `{api_key, model, protocol}`,
>   protocol ∈ anthropic|openai_chat|openai_responses;key 复用 model_api_keys,流量走 LLMProxy
> - `GET /api/v1/desktop/agent-resources`(Bearer)→ `{rules:[{name,content}], skills:[{name,version,description,zip_url}]}`,
>   规则内联、技能 presigned zip;注意 dispatch 查询语义是 {选中}∪{force_delivery},全量下发需先 listing 转选中集

### 内核 `agent/`

- [x] `internal/config`:新增 platform_url / platform_token / platform_model_id(env `MC_AGENT_PLATFORM_*` +
      config 文件);Validate 放宽:直连三元组 或 platform 二元组 任一满足
- [x] `internal/platform`:client(ExchangeCode/FetchRuntimeKey/FetchResources)+ Sync(技能 zip 下载
      解包到 ~/.cache/mc-agent/platform/<host>/,zip-slip/文件数/大小防护,同版本跳过)+
      LoadCached 离线兜底 + LoginViaBrowser(loopback 回调 + state 校验)
- [x] `mc-agent login <url>` / `logout`;config get 显示平台登录态
- [x] applyPlatform:无直连 key 时换运行时 key,protocol→provider(anthropic→平台源;openai_chat→
      平台源+/v1;openai_responses 明确报不支持),run/chat/serve 全路径生效
- [x] `internal/contextmgr`:Build(workdir, extras)——# 平台规则(内联,32KB 截断)+ # 平台技能
      (名称/描述/入口文档索引,模型按需 read_file)
- [x] 技能缓存在工作区外:Env.ReadRoots 只读附加根(仅 read_file 放行,写/编辑仍限工作区),
      loop.Options/server.Options 透传
- [x] 单测:platform 5 例(httptest 假平台、zip-slip、文件数上限、缓存兜底)、contextmgr 3 例、
      config 3 例、tools ResolveForRead 1 例

### 验证

- [x] backend:go build ./... + go vet + biz/desktop 单测过
- [x] agent:gofmt 干净 + go vet + 全部 13 包单测过
- [x] 真实二进制端到端(假平台进程):`mc-agent login` 浏览器流(authorize 302→loopback 回调→
      token 写配置)→ `mc-agent run` 换运行时 key→ 技能 zip 落盘缓存 → 系统提示含平台规则与技能索引
      (假平台侧断言 SYSTEM_HAS_RULE/SKILL=true)→ Anthropic SSE 回复正常渲染

### 偏差(有意取舍)

- 桌面 token 存 Redis 长效(TTL=Session.ExpireDay),keychain 存储属 Tauri 壳(M3);内核配置文件 0600 兜底
- 运行时 key 复用 model_api_keys(持久 uuid),"短时效轮换"待后端 key 过期机制,不阻塞计量/审计(流量已走 LLMProxy)
- 未登录 authorize 302 到 /login?redirect=...,前端登录页暂不消费 redirect 参数(登录后需重开授权 URL);前端支持后自动闭环

---

# M2.5:agent/desktop 能力完善(不动后端,2026-07-13)✅

## 内核:本地技能

- [x] `internal/skills`:本地技能发现——项目 `.mc-agent/skills/<name>/SKILL.md` + 全局
      `<配置目录>/skills/<name>/SKILL.md`,同名项目优先;SKILL.md 可选 frontmatter
      (name/description),缺省取目录名与正文首个非标题行
- [x] 装配:skills.Assemble 合并本地与平台技能(本地优先)进 contextmgr.Extras;全局技能目录进
      ReadRoots(项目技能本在工作区内无需附加);serve 改为 Options.BuildExtras 按会话工作区装配,
      run/chat/serve 全路径生效
- [x] `mc-agent skills` 子命令:列项目/全局/平台缓存三来源(不发网络请求)
- [x] 单测 4 例:发现/frontmatter 解析/项目覆盖全局/本地平台合并与只读根
- [x] README 增"技能"一节

## 桌面壳:托盘常驻

- [x] 托盘图标 + 菜单(显示窗口/退出 MonkeyCode)+ 左键单击恢复窗口;内核运行且托盘可用时关窗
      只隐藏,托盘"退出"才真正退出(内核随 stdin 看门狗回收)
- [x] 降级:托盘创建失败(无 StatusNotifier 宿主)或内核启动失败错误页 → 关窗直接退出,
      并放行 ExitRequested,避免无窗无托盘僵尸进程
- [x] cargo build 过;无头冒烟(xvfb+dbus):壳拉起内核就绪 → SIGKILL 壳 → 内核跟随退出无孤儿
- [x] README:托盘一节 + 路线图勾掉

## 验证

- [x] agent 全部 14 包测试过、gofmt/vet 干净
- [x] 真实二进制端到端:项目技能 + 全局技能 + 平台缓存技能三来源 `mc-agent skills` 正确列出;
      run 时系统提示同时含三来源技能索引与平台规则(假平台侧落盘断言 6 关键词全中)
- [x] mc-desktop 构建 + 无头冒烟过

---

# M2.6:sub-agent + 独立 React UI(2026-07-13)✅

## 只读探索子代理(task 工具,M4 提前)

- [x] `internal/subagent`:task 工具(description+prompt)→ 独立 loop.Engine,受限工具集
      read_file/grep/glob/git(无 bash/写/编辑/todo/task 自身→无递归、整体只读、yolo 无权限旁路)
- [x] 独立探索型系统提示;步数上限 25;部分结论 + 提前终止时不丢弃(附终止说明返回)
- [x] 用量经 OnUsage 回灌主引擎;CLI(buildApp)与 serve 双路径接入,task 自动放行
- [x] 单测 4 例(scripted provider):探索问答/工具集白名单断言/写工具不可用/部分结论容错
- 偏差:子代理帧静默(主流程只见 task 调用卡片),嵌套帧展示留 M4;eval 未注入(保持基线可比)

## 独立 React UI(替换内嵌调试 UI)

- [x] `agent/ui` 工程:React 18 + TS(strict)+ Vite,vite-plugin-singlefile 打成单 HTML,
      产物 `cmd/mc-agent/uidist/index.html` 入库 → serve go:embed,内核 Options.UI 零改动,
      go build 不依赖 node;旧 ui.html 删除
- [x] 功能对齐并增强:会话列表(状态点)/新建(worktree 选项)、流式对话(**Markdown 渲染**,
      DOMPurify 净化)、思考/工具行/计划卡(原地更新不追加)、审批卡四按钮与终态回写、
      改动 Tab + diff 弹层、上下文用量、断线重连、rAF 批量消费、智能吸底滚动
- [x] 帧归约为纯函数(src/reduce.ts)与连接层(src/client.ts)分离,tsc strict 通过
- [x] 验证:npm build + go 全量测试过;真实 serve 冒烟(UI 232KB 正确服务);Node 22 内置
      WebSocket 按 UI 协议路径全链路 e2e(建会话→user-input→帧流→task-ended→call 改动查询
      检出新增文件)PROTO_ALL_OK
- [x] 文档:agent README(子代理 + UI 开发流程)、mc-desktop README 路线图更新

---

# M2.8(进行中):壳持有配置——桌面自足闭环(2026-07-14,方向重定)

> 架构决定(用户拍板):配置与设置归壳,agent 只是壳拉起的进程。
> 曾按"内核配置 REST"实施半程,已全部回滚,agent 零改动。
> 关键接缝:内核 config.Load 的 env 覆盖(MC_AGENT_*)本来就存在——壳把自己
> 存的配置经环境变量注入 spawn 的内核即可,不碰内核代码、不污染 CLI 用户的
> config.json;env 也不像 argv 那样暴露在 ps 里。

> 扩围(用户确认):每会话可用不同模型(可跨 provider),且会话内可切换
> (轮次间生效;消息历史是归一化格式,跨 provider 续聊安全)。
> 一个 agent 进程承载全部会话不变(serve 本就每会话独立 engine/provider)。

## 内核(仅消费侧改动)✅

- [x] 模型清单:config.LoadModels 读 `MC_AGENT_MODELS` JSON 数组(name 缺省取 model、
      名称唯一、default 恰一个);无清单退回现有单配置
- [x] server.Options:NewProvider(model)+ListModels;`GET /api/models`;
      `POST /api/sessions` 带 model(未知名 400);call `session_set_model`(执行中拒绝,
      成功换 engine/子代理 provider + meta 落盘 + model_update 帧进日志,回放可见)
- [x] loop.Engine.SetProvider;顺手修了真 bug:startTurn 延迟收尾可能清掉新轮次
      running(turnSeq 代号守卫)+ task-ended 帧经 emit 先复位 running(帧是客户端
      行为契约,状态先于帧可见)

## 壳(mc-desktop)✅

- [x] 配置存储:app_config_dir/config.json + models.json(0600);壳持有,内核只消费
- [x] 设置页 ui/settings.html:模型增删改/设默认;get_config/save_config/open_settings_window
      三个 command;withGlobalTauri + 内联 capability
- [x] 首启无配置 → 设置窗口(不 spawn 内核);保存 → 写清单 → spawn(env 注入,不走 argv
      防 ps 泄漏)→ 主窗口进内核 UI;托盘加"设置"项,保存即重启内核换新 URL
- [x] 错误页去内核化:文案不再提 mc-agent,加"打开设置"按钮

## UI ✅

- [x] 新建会话模型下拉(默认预选,单模型时隐藏)
- [x] 侧栏底部"⚙ 设置"按钮 → Tauri IPC 唤起壳设置窗口(remote capability 放行
      127.0.0.1 源;浏览器直连模式降级为提示);会话列表不展示模型(用户要求)
- [x] 状态栏模型下拉切换(运行中禁用,title 提示)→ call session_set_model;
      model_update 渲染为"模型已切换为 X"系统行

## 验证 ✅

- [x] 内核单测:models 6 例 + server 端到端 1 例(清单/未知名 400/按会话解析/切换流转/
      运行中拒绝/meta 落盘);全部 15 包过,gofmt/vet 干净;UI tsc+build 过
- [x] e2e(echo-llm 按请求回显 model+key):会话绑乙 → 首轮 MODEL=model-b|KEY=key-b;
      切甲 → 次轮 MODEL=model-a|KEY=key-a;列表 meta 更新(MODEL_E2E_OK)
- [x] 壳无头冒烟:无配置 → 不 spawn 内核、开设置窗;写入配置重启 → 内核环境含
      MC_AGENT_MODELS 指向壳写的清单、就绪;壳被杀内核跟随退出无孤儿

---

# M2.10:桌面体验五连修(2026-07-14,用户反馈)✅

- [x] 1 新建会话选目录:壳接 tauri-plugin-dialog,UI"浏览…"原生目录选择(浏览器模式隐藏);
      server 支持 create_dir,UI 报"目录不存在"时内联"创建该目录并继续"(api 错误改带服务端 message)
- [x] 2 会话按项目组织:侧栏按 workdir 分组(worktree 会话归 Worktree.Repo),组按最近活动
      排序、可折叠(localStorage 记忆),组头"+"预填目录新建;会话条目简化(去目录/模型)
- [x] 3 隐藏 worktree 勾选(内核/CLI 能力保留;worktree 会话条目带"隔离"标记)
- [x] 4 回放提速:loadCompactedReplay——连续同类文本增量合并单帧、usage 只留末帧、
      bash output 进度帧丢弃、其余语义帧透传;主回放与子会话观察者共用;
      3000 帧压到 <50 帧(测试锁定),文本完整性断言
- [x] 5 压缩提示展示:compact_status 帧 React UI 渲染为系统行(此前仅 CLI 有)
- [x] 6 上下文统计虚高(用户反馈):provider 对流式 usage 用 Add 累加,而协议中
      message_delta/chunk 的 usage 是累计快照,网关每增量都带时统计被吹到数倍;
      改为 Usage.Merge 快照语义(input 取最新非零、output 取最大),Add 保留给
      会话级跨请求累计;anthropic/openai 双路径 + 回归测试(累计快照流形态)
- [x] 验证:go 全量过(新增 TestReplayCompaction,改 TestWSReplayLargeHistory 为
      文本完整性+帧数上限);create_dir 端到端(400→create_dir→目录落盘);
      MODEL_E2E_OK 回归;壳 IPC 探针 OK

---

# M2.9:设置增强——MCP 配置 + 单窗口设置页(2026-07-14)✅

- [x] MCP 进设置:壳存 mcp_servers(与内核 mcpServers 同构,壳不解释原样写盘),
      设置页增删改(HTTP url+headers / stdio command+args+env,K=V 行编辑);
      spawn 注入 MC_AGENT_MCP_CONFIG(内核 env 覆盖点已存在,零改动);
      项目级 .mc-agent/mcp.json 不变(同名覆盖全局)
- [x] 设置改单窗口:主窗口存在时窗口内导航到设置页(tauri://localhost origin),
      保存/返回导航回内核 UI(KernelUrl 状态);首启无主窗口才独立开窗;
      新增 close_settings 命令(build.rs + capability 同步授权)
- [x] 验证:cargo build(ACL 编译期校验);无头冒烟——内核环境含
      MC_AGENT_MODELS 与 MC_AGENT_MCP_CONFIG、mcp.json 落盘、IPC 链路 OK;
      探针加 origin 守卫防设置页循环触发

---

# M2.11:子代理步数可配 + 并行执行(2026-07-14,用户反馈)✅

> 反馈:子代理 25 步上限写死不合理;同批多个 task 调用串行排队,没有真并行。

- [x] 步数上限:subagent defaultMaxSteps 25→50;`--subagent-max-steps` 持久 flag
      贯通 run/chat/serve(server.Options.SubagentMaxSteps → sub.MaxSteps)
- [x] 并行执行:tools.Parallelizable 可选接口(只读、无跨调用状态的工具声明可并行),
      loop.execBatch——同批可并行工具并发执行(goroutine + 按 tool_use 原序回填),
      其余工具(bash/写/编辑)在并行组结束后保持串行;task 工具声明可并行,
      工具描述提示模型"互不依赖的探索任务一次发起"
- [x] 并发安全:Engine.emit 加锁(下游渲染器/会话日志免锁)、每次调用独立 tools.Env
      (进度闭包捕获各自 toolCallId,不串扰)、AddUsage 锁保护(子代理用量回灌,
      CLI/serve 两处 OnUsage 改走它);frame.Builder seq 本为 atomic、policy/publishChild
      已有锁、session newID 带随机后缀,均无需改动
- [x] 展示:帧协议不变;React UI reduce 本就按 toolCallId 挂子步骤,并行天然分组;
      CLI 渲染并行时子步骤行交错(可接受,结构化端不受影响)
- [x] 验证:新增 loop 并行单测(屏障工具断言真并发 + 结果顺序 + 进度帧归属),
      全部 16 包 -race 通过,gofmt/vet 干净,--help 现新 flag

---

# M2.12:mc-desktop 自动更新(2026-07-14)✅

> OSS 静态清单 + tauri-plugin-updater,壳整包更新(内核 sidecar 随包);
> 版本号 YYMMDDNN(日期序号占 semver 主版本位),不一致即提示,用户确认后更新重启。
> 发布:CI 出签名产物(Actions Artifacts),人工上传 OSS public/desktop/。

- [x] 签名密钥:minisign 密钥对(~/.tauri/monkeycode-desktop.key,公钥入 tauri.conf.json;
      私钥待配 GitHub secret `TAURI_SIGNING_PRIVATE_KEY`)
- [x] 配置:tauri.conf.json 版本 26071401.0.0 + plugins.updater(pubkey/endpoints);
      tauri.release.conf.json(createUpdaterArtifacts,仅发布构建叠加,本地打包不需私钥)
- [x] 壳(main.rs):check_update(version_comparator 远端≠本地即更新、MC_UPDATE_MANIFEST
      测试覆盖、短版本号展示)→ dialog 询问 → download_and_install → restart(内核经
      RunEvent::Exit 回收);启动 5 秒自检(debug 默认跳过);托盘"检查更新"菜单项
- [x] 发布链:Makefile macos-release(校验私钥 + 叠加 release 配置 + gen-latest-json.py
      汇集 updater/ 产物);CI secret 就绪走发布构建否则回退,Artifacts 加 updater/*
- [x] 验证:cargo build 过;Linux 无头端到端两场景(清单 99999999 → "发现新版本"日志、
      清单同版本 → "当前已是最新版本(26071401)",短版本号正确);gen-latest-json.py
      假产物跑通(双 darwin key 同 URL、多行签名正确转义);macOS 完整链路待真机(README 有步骤)
- [ ] 待办:GitHub 配置 `TAURI_SIGNING_PRIVATE_KEY` secret(cat ~/.tauri/monkeycode-desktop.key);
      OSS 确认 release.monkeycode-ai.com/public/desktop/ 可公网匿名读
- v2 留:内核独立热更新(清单 kernel 段 + find_agent 覆盖位 + 复用重启内核路径)

---

# M2.13:设置 UI 统一进内核 React UI,壳退纯宿主(2026-07-14)✅

> 动机:产品界面分裂在两套栈(聊天=agent/ui React,设置/错误页=壳 vanilla HTML),
> 已造成"重构桌面客户端只改了壳页面"的返工。收敛:设置渲染进内核 UI,
> 配置所有权仍在壳;支点=内核零模型可启动,解开"没配置→内核起不来→没设置页"死锁。

## 内核(agent/)
- [x] LoadModels:空清单 `[]` 合法(返回非 nil 空切片,区分"未设置清单"=nil);
- [x] serve 三分支:多模型 / **零模型**(清单空:ListModels=[]、NewProvider 报"尚未配置模型")/ 单配置(CLI 不变);
      **清单内容错误不致死**(stderr 警告 + 降级零模型,防坏配置持久化后死锁)
- [x] 版本外显:server.Options.Version → /healthz 带 version(v2 内核热更新握手的接缝)
- [x] 测试:TestLoadModelsEmptyManifest、TestZeroModelServe(models=[]、建会话 400 引导文案、healthz 版本)

## React UI(agent/ui/)
- [x] src/settings.tsx:设置视图(模型 CRUD+设默认+provider 三值;MCP http/stdio+KV 文本域;
      parseKV/mcpsToServers 从 settings.html 移植为 TS);保存→壳写盘重启内核→整页导航重载
- [x] client.ts:getHostConfig/saveHostConfig(照 pickDirectory 的 invoke 模式)、onHostEvent(托盘事件);
      openHostSettings 删除;types.ts 加 HostConfig/HostModel
- [x] App.tsx:view 加 "settings";⚙ 按钮/Esc/托盘 open-settings 事件进出;
      桌面壳内模型为空启动直接进设置向导

## 壳(mc-desktop/)
- [x] 无条件拉内核(无配置写空清单);删 open_settings_window/close_settings/open_settings/
      app_page_url/KernelUrl/ModelEntry/valid();DesktopConfig 改 opaque JSON 透传(schema 双定义消除)
- [x] 托盘"设置"→show_any_window + emit_to("main","open-settings");无头探针改验 get_config
- [x] build.rs commands 缩为 get_config/save_config;capabilities:kernel-ui 放行 get/save-config,
      shell-pages 缩为错误页 core:default;删 ui/settings.html,错误页去"打开设置"按钮

## 验证
- [x] agent 全量测试/gofmt/vet 过;UI tsc+build 过;壳 cargo build(ACL 编译期校验)过
- [x] 无头端到端 5 场景:A 无配置首启零模型(/api/models=[]、healthz 带 version)、
      B 写配置重启生效(models.json 落盘+API 返回)、C 坏配置容错(重复名→零模型+警告不死)、
      D IPC 探针(remote origin invoke get_config OK)、E SIGKILL 壳内核跟随退出
- [ ] Mac 真机人工:首启进设置向导→配模型→聊天;托盘"设置";保存后会话列表不丢

---

# M2.14:会话删除/归档(2026-07-15)✅

> 归档=Meta.Archived 标记(可逆,UI 折叠到"已归档"组);删除=不可恢复,
> 级联子会话 + worktree 连带回收,运行中 409 拒绝(先停止再删)。

- [x] session:Meta.Archived;Delete(ID 防逃逸+存在性校验+RemoveAll);
      SetArchived(非 live 磁盘直写;live 必须走内存副本防轮次收尾覆写)
- [x] server:`DELETE/PATCH /api/sessions/{id}`;teardownLive(首个单会话回收路径:
      断客户端/mcp/engine/sess.Close/摘 live 表,running 拒绝);dropChildWatchers;
      删除级联 Parent 子会话 + Worktree.Remove(best-effort)
- [x] UI:SessionRow 悬停 ⋯ 菜单(归档/删除,删除内联确认,worktree 提示连带删除,
      running 禁用);侧栏"已归档 (n)"折叠组(localStorage 记忆);删当前会话复位回新建视图
- [x] 验证:session 2 例 + server 3 例(含 live 归档不被轮次覆写、子会话级联、运行中 409),
      全量测试/gofmt/vet 过;UI tsc+build 过;REST 端到端(归档落盘/删目录/worktree 目录与
      git 登记回收/404);壳无头探针回归 4 项全过
- [ ] Mac 真机人工:行悬停 ⋯ → 归档/展开回看/取消归档;删除当前会话回到新建任务视图

---

# M2.7:子代理可观测性——B 进度通道 + C 子会话(2026-07-13)✅

## B:工具进度通道(通用原语)

- [x] frame.ToolCallUpdate 增 Progress 字段(tool_call_update{status:in_progress, progress},
      旧客户端忽略未知字段,协议向后兼容)
- [x] tools.Env 增 Progress func(ProgressUpdate) + EmitProgress(nil 安全);loop 执行工具前注入
      (闭包捕获 toolCallId),defer 置空;载荷 kind: subagent_tool | output | child_session
- [x] subagent:静默 emitter → progressMapper,子代理 tool_call/tool_call_update 压缩为
      {kind:subagent_tool, id, title, status:run/ok/fail};文本/思考不透传
- [x] bash:CombinedOutput → progressWriter,≥500ms 节流上报最新完整输出行(kind:output,
      跳过内部 cwd 标记行),长命令可见"跑到哪了"
- [x] CLI renderer:`↳ ✓ 读取 auth.go` 缩进渲染子代理步骤(bash output 不刷屏,跳过);
      UI:task 工具行下嵌套子步骤、bash 显示斜体实时输出行(完成后清除)

## C:子会话一等公民

- [x] session.Meta 增 Parent;subagent 创建真实子会话(meta.Parent=主会话,title=description,
      events.jsonl 完整帧流,messages/usage/status 落盘);无 SessionRoot(--no-session)优雅降级
- [x] 进度通道公告 childSessionId(kind:child_session);OnChildFrame 钩子帧落盘后实时外发
- [x] sessions 列表默认隐藏子会话:CLI `--all` 缩进显示,server `?all=1`
- [x] server WS 观察者路径:meta.Parent 非空 → 不建引擎不收上行,持锁回放 + seq 水位订阅
      publishChild(回放/实时无缝无重帧);同进程直发,无需 tail 文件
- [x] UI:task 卡片"查看子会话"→ 弹层 SessionViewer(复用 connect+reduce 只读渲染,支持
      运行中实时跟看与事后回放)

## 验证

- [x] 单测:loop 进度注入(挂对 toolCallId、用后置空)、subagent 子会话落盘/进度序列/无根降级、
      server 观察者(列表过滤、回放 seq、上行忽略、实时分发、水位去重);全部 15 包过,gofmt/vet 干净
- [x] UI tsc strict + vite build 过
- [x] 端到端(有状态假平台:主→task→子代理 read_file→子结论→主收尾):WS 收到 child_session 公告
      与 subagent_tool run/ok 进度帧;子会话观察者回放 8 帧含子代理工具帧与结论;列表过滤与 parent
      字段正确(BC_ALL_OK);CLI 渲染 `⏺ 子代理探索 → ↳ ✓ 读取 hello.txt → ✓ 子结论`;
      sessions/--all 缩进显示子会话

# 会话级 YOLO 模式(2026-07-15)

> 计划:~/.claude/plans/fluffy-dreaming-tome.md。用户拍板:会话内随时切换(⇧Tab);
> 语义与 CLI --yolo 完全一致(完全放行);只改内核+UI,不碰壳。

- [x] policy:Engine.SetMode/Mode(加锁),decide() 改锁内快照读 mode
- [x] frame:KindSessionSetMode + PermissionModeUpdate 帧(sessionUpdate:permission_mode_update)
- [x] session.Meta 增 Mode(omitempty,空=default);newLiveSession 按 meta 恢复引擎模式
- [x] server:liveSession.setMode(幂等校验→切引擎→yolo 时排空 pending asks 自动批准→meta 落盘→广播);handleCall 接线
- [x] UI:reduce 处理 permission_mode_update(sys 行+permMode);App.tsx yolo 状态/toggleYolo(乐观+回滚)/composer 红框+pill(⚡ YOLO / 🛡 默认权限)/⇧Tab 快捷键;openSession 传 meta.mode
- [x] 修复既有竞态:startTurn 两处 Meta 写/SaveMeta 无锁,与 setModel/setMode 并发 race(-race 复现),统一持 ls.mu

## 验证

- [x] 单测:policy 运行期切换(含 sudo 危险命令 yolo 放行)+并发冒烟;server WS 切换/pending 自动批准
      (真实 write_file 落盘)/重建 liveSession 按 meta 恢复;-race ×3 全绿,全仓 go test 过,tsc 过
- [x] 端到端(新构建二进制 + 真实 serve):WS call session_set_mode → call-response + 广播帧;
      重连回放含模式帧;meta.json/sessions API 带 mode;切回 default 后 meta 清空

# 修复:中断丢弃工具结果导致会话报废(2026-07-15)

> 用户报告:多个 subagent 并行时其一报错,继续对话接不上,报 "toolcall result 不存在"。
> 根因:RunTurn 先把 assistant 的 tool_use 消息入历史,execBatch 中断时却丢弃整批
> tool_result → 悬空 tool_use 落盘,后续每轮请求被 API 拒绝
> (`tool_use ids were found without tool_result blocks immediately after`),会话永久报废。
> 多 subagent 使执行窗口长达数分钟,其一报错时用户取消轮次即触发。

- [x] loop.execBatch:中断不再丢结果——已执行的保留真实结果,未执行的补"工具执行被中断"
      占位;RunTurn 先追加结果消息再返回 ErrInterrupted,历史恒保持配对完整
- [x] loop.RepairHistory:为悬空 tool_use 补合成错误 tool_result(尾部悬空插新消息,
      后跟用户文本则插到文本块前);serve 加载会话时过一遍,救活存量损坏会话

## 验证

- [x] 单测:中断时配对完整(2 并行阻塞桩 + 1 串行未执行)+ 中断后续聊;RepairHistory
      四场景(完好不动/尾部悬空/悬空后接文本/部分缺失);-race 全绿,全仓测试过
- [x] e2e(真实网关):手工构造悬空 tool_use 会话 → 旧二进制续聊报
      "tool_use ids found without tool_result"(即用户所见错误),新二进制续聊 task-ended

# 子代理进度窗口重设计(2026-07-15)

> 用户反馈:task 卡片只显示 toolcall,模型回复文本不可见;"已省略前 N 步"不合理,
> 期望固定 3-5 行持续滚动。

- [x] progressMapper:回复文本按行上抛(kind=subagent_text,跨 chunk 拼行,单行 200 字截断,
      工具调用前/轮次结束时冲刷残余;思考流仍不上抛)
- [x] UI:subItems 重构为 feed(工具步骤+文本行时间序混排,内存上限 200 条),
      卡片固定渲染最后 5 条,旧条目自然滚出,删除"已省略前 N 步"行;
      文本行 t5 色无状态标记,工具行样式不变
- [x] 帧进事件日志(回放压缩仅丢 bash output),刷新后卡片内容不丢

## 验证

- [x] 单测 TestProgressMapperTextLines(拼行/空行跳过/冲刷时机/截断);全仓 -race 过,tsc 过
- [x] e2e(真实模型):子代理轮次产生 3 条 subagent_text(探索前说明+结论)与
      subagent_tool run/ok 混排,落盘 events.jsonl

# 单轮步数上限调整(2026-07-15)

> 用户在真实任务中撞上"达到单轮最大步数 80,任务未完成"。

- [x] 默认最终定为主循环 10000、子代理 5000(纯保险丝,交互场景靠用户取消兜底)
- [x] serve 链路接通 --max-steps(此前只有 run/chat 生效,桌面端写死 80)
- [x] 报错文案引导恢复:步数耗尽时历史配对完整,提示"回复「继续」可接着执行"

# 模型级上下文窗口配置(2026-07-15)

> 用户反馈:模型配置没有上下文大小配置,压缩预算全局写死 180k(serve 路径甚至没接线,
> 32k 小模型永不压缩直接溢出,1M 大模型 144k 就开始压缩)。
> 方案:模型清单加高级项 context_window(设置表单默认折叠),默认 200k,配了用配置值。

- [x] `internal/config/models.go`:ModelProfile 加 `context_window`(可选,负数报错)
- [x] `internal/loop`:默认预算 180k→200k;Engine.SetContextBudget(切模型时同步,<=0 回退默认)
- [x] `internal/server`:Options.ContextBudget(model) 回调;newLiveSession/setModel 接线
      (此前 serve 路径压根没接 ContextBudget,桌面端一律 180k)
- [x] `cmd/mc-agent`:serve 多模型分支提供回调;--context-budget 帮助文案改 200000
- [x] UI:HostModel 加 context_window;settings.tsx 模型卡"高级选项"折叠区
      (默认收起;已配置时折叠标题带出当前值;删除模型时折叠态复位防索引错位)
- [x] 验证:models 负值用例 + TestModelContextBudget(usage 帧 size=32000 →切模型→200000);
      全仓 go test -race 过,gofmt/vet 干净;UI tsc+build 过,uidist 重建;
      真实二进制冒烟——带 context_window 清单正常起服,负值降级零模型模式(警告不致死)

# 修复:主题等 UI 偏好重启即丢(2026-07-15)

> 用户反馈:切到亮色,重开应用又回到暗色。
> 根因:壳每次启动随机端口,localStorage 按 origin(协议+主机+端口)隔离,
> 端口一变即全新 origin——主题、项目分组折叠、归档折叠全部每次丢失。

- [x] 壳 kernel_port:端口首次分配后持久化(配置目录 port 文件),之后复用;
      被占用才换新并持久化(打警告);写盘失败不致死
- [x] save_config 重启内核改"先停旧再起新"(同端口复用前提;此前先起新再杀旧,
      固定端口下新内核必撞旧内核占用,还会把持久化端口顶掉)
- [x] README 进程生命周期一节更新

## 验证

- [x] cargo build 过;无头冒烟三场景:首启分配并落盘 45789 → 二次启动复用同端口 →
      预占端口后启动打"被占用换新端口"警告并持久化新端口

# 修复:保存配置永卡"保存中"(端口固定化的回归,2026-07-15)

> 用户反馈:保存配置一直停在"保存并重启内核中"。两个叠加原因:
> ① 端口固定后新旧 URL 仅 #token 不同,同文档导航不重载页面(原先整页重载
>   隐式依赖"端口每次都变");
> ② save_config 命令内同步导航,WebKitGTK 重放"导航时响应未送达"的 IPC
>   请求 → 同一 invoke 二次进入命令,内核被重启两次(配置塞随机指纹实锤:
>   两次调用指纹相同 = 传输层重放)。

- [x] kernel_ui_url:URL 加每次内核启动都变的 boot 查询参数,查询串变化强制整页重载;
      token 仍走 fragment 不上请求行
- [x] save_config:导航延后到命令返回之后(spawn + 200ms),先让 IPC 响应落地
- [x] 探针升级:save_config→内核重启→页面重载全链路(sessionStorage 跨重载标记,
      第二次加载报 reload-after-save-ok);script-injected 带 boot 与标记状态

## 验证

- [x] 无头端到端:script-injected(load1) → invoke-ok → save-ok(响应送达)→
      新 boot 重载(saved=1)→ reload-after-save-ok;save_config 仅执行一次;
      nav-guard-ok 回归不受影响;端口文件持久化正常

# 修复:升级重启后"继续"上下文丢失(2026-07-16)

> 用户反馈:检查更新升级 mc-desktop 后,会话提示"服务已重启,上一轮执行已中断;
> 历史已保留,请重新发送指令继续",发"继续"发现模型没有上下文。
> 根因:messages.json(模型上下文)只在轮次收尾落盘,而壳在升级重启/保存设置/
> 退出时对内核 child.kill()(SIGKILL),执行中轮次的消息全部丢失;
> events.jsonl(UI 回放)逐帧实时落盘所以界面看着完好,更具迷惑性。
> 内核本有优雅退出路径(SIGTERM/stdin 关闭 → 取消轮次 → 等落盘),壳没走。

- [x] mc-desktop/src/main.rs:新增 stop_kernel(关 stdin 管道触发内核优雅退出,
      10s 超时兜底强杀),替换 save_config 与 RunEvent::Exit 里的裸 kill
- [x] agent/internal/server:ListenAndServe 收尾逻辑抽成 drainLive(行为不变),
      补回归测试 TestDrainLiveSavesInFlightTurn 钉住"优雅停机落盘执行中轮次"契约

## 验证

- [x] cargo check 通过(mc-desktop)
- [x] 实测内核 stdin 关闭 → 0.0s 优雅退出、退出码 0(--watch-stdin 契约成立)
- [x] TestDrainLiveSavesInFlightTurn:轮次阻塞在 LLM 请求时 drainLive,
      messages.json 含本轮用户输入、meta 状态 interrupted
- [x] agent 全量 go test ./... 通过


# 重构:按新设计稿重做 agent/ui(2026-07-16)

> 设计稿:agent/ui/MonkeyCode 桌面应用设计.html(bundler 打包,已解包分析)。
> 浅色绿调 macOS 风格,四屏:侧栏 / Chat / New Task / Settings。
> 协议层(client/reduce/types)不动,视图层全部重写并拆分文件。

## 设计稿 → 功能映射决策

- 侧栏:云端任务空态 + 本地会话分组(悬停 +/⋯ 菜单:归档/删除,删除保留内联确认);
  无搜索框(设计稿删除了 ⌘K 搜索,跟随);已归档作为置灰分组
- Chat:标题栏(标题+目录+改动按钮+⋯);空会话态;用户气泡右对齐;思考单行折叠;
  工具/子代理白卡;"本轮结束"分隔线;运行条(轮次+tokens+停止);排队 chip;
  composer(权限 pill 默认/YOLO 循环 ⇧⇥ + 模型菜单 + 上下文圆环 + 发送)
- New Task:居中卡(文件夹下拉:最近目录+选择其他/手动输入)+ 本地/云端分段
  (云端显示"准备中"提示,仍建本地会话)+ 模型 + 开始任务;目录不存在确认创建保留
- Settings:外观(浅色固定,深色置灰"即将支持")/ 关于(版本+检查更新,壳内可用)/
  模型卡(可编辑,高级选项=上下文窗口)/ MCP 段保留(设计稿没画,按同卡风格)
- 主题:跟随设计稿改为浅色单主题,移除深色(mc.theme 弃用)
- 壳新增:host_info(版本)、update_check、update_install 三命令 + capability;
  macOS titleBarStyle Overlay(侧栏顶部留红绿灯拖拽区,仅 mac 壳内渲染)

## 任务

- [x] 壳:host_info/update_check/update_install 三命令 + build.rs 命令清单 +
      capability 权限 + macOS titleBarStyle Overlay(cfg 门控,未在 mac 实测)
- [x] styles.css:新设计令牌(浅色绿调)+ hover/keyframes/md 样式
- [x] icons.tsx:设计稿 SVG 图标集(20 个)
- [x] components.tsx:重样式(Markdown/Thought/Plan/Tool/Perm/Diff/LogList/本轮结束分隔)
- [x] sidebar.tsx / chat.tsx / newtask.tsx / settings.tsx:四屏重写
- [x] App.tsx:精简为状态容器 + 布局切换;client.ts 加宿主更新 API
- [x] index.html:浅色底色,移除主题闪屏脚本
- [x] 构建:tsc 零错误 + vite build(306KB 单文件)→ uidist 入库;cargo check 通过
- [x] 验证:内核 serve + 无头 Chromium 实测

## 验证

- [x] 四屏截图核对:侧栏(分组/悬停⋯菜单/归档组/连接状态)、Chat(标题栏+改动徽标、
      用户气泡、思考折叠、工具卡、本轮结束分隔线、composer 权限 pill/模型菜单/
      上下文圆环)、New Task(文件夹下拉+最近目录+手动输入、本地/云端分段、云端提示)、
      Settings(外观/浏览器只读提示)
- [x] 真实历史会话回放渲染正常(markdown 表格/代码块/子代理卡);改动抽屉 + diff 正常
- [x] 全程无 pageerror/console error
- [ ] macOS 红绿灯 Overlay 与桌面壳内 关于/检查更新 卡片待真机回归(本机无 mac/无显示)


# 2026-07-16:Windows 自绘标题栏 + Windows 自动更新

> 计划:~/.claude/plans/cozy-enchanting-crescent.md(已批准)
> 取向:36px 细自绘标题栏;更新清单拆分端点(latest-windows.json / latest-win7.json)

## A. Windows 无边框 + 自绘标题栏

- [x] main.rs:主窗口 Windows 分支 decorations(false)
- [x] tauri.conf.json:kernel-ui 加 window 权限(已对照 gen/schemas 核实名字)
- [x] client.ts:isWindowsShell + 窗口控制封装
- [x] titlebar.tsx(新):36px 标题栏(拖拽区 + 最小化/最大化/关闭)
- [x] App.tsx:根布局改 column + 条件渲染 TitleBar

## B. Windows 自动更新

- [x] tauri.windows.conf.json:updater 端点 → latest-windows.json
- [x] main.rs:build_updater 加 on_before_exit 回收内核(防 NSIS 文件占用)
- [x] gen-latest-json.py:平台模式 macos/windows/win7
- [x] Makefile:windows-release 目标
- [x] desktop-windows.yml / desktop-win7.yml:secret + release 构建 + 清单 + artifact
- [x] README:发布流程文档

## 验证

- [x] agent/ui npm run build 过;mc-desktop cargo check 过
- [x] gen-latest-json.py 三模式假产物 dry-run
- [ ] 推 CI 核对产物(exe + .sig + 清单)
- [ ] Windows 实机人工验证(标题栏 + 更新全链路)

## Review

- 标题栏:壳 Windows 分支 decorations(false);UI 新增 titlebar.tsx(36px,拖拽区 +
  最小化/最大化-还原/关闭,close hover 红底白字),App 根布局改 column 条件渲染;
  窗口命令走 core.invoke("plugin:window|…")(与 dialog/opener 惯例一致),权限名
  已对照 gen/schemas 核实。关闭按钮走壳的 CloseRequested 拦截 → 隐藏到托盘。
- 自动更新:根因 = Windows 构建无签名 updater 产物 + latest.json 无 windows 条目。
  端点拆分(latest-windows.json / latest-win7.json),gen-latest-json.py 平台模式化,
  两条 Windows CI 加 secret 发布构建(无 secret 降级不红),Makefile 加 windows-release。
  关键坑修复:updater 在 Windows 硬退进程不走 RunEvent::Exit,build_updater 加
  on_before_exit 先 stop_kernel,否则 mc-agent.exe 锁文件 NSIS 安装必败。
- 验证:tsc+vite 过;cargo check 过;清单脚本三模式假产物 dry-run 结构正确;
  无头 Chromium 截图(mock Windows 壳)标题栏渲染正确,浏览器模式无标题栏。
- 遗留:现存 Windows 安装端点烧的是 latest.json,需手动重装一次进新通道(已确认接受);
  Win11 无边框失去最大化按钮 hover 的 Snap Layouts 弹层。

# 功能:会话支持粘贴/拖拽图片(2026-07-16)

> 方案(与用户对齐):图片落成工作区文件 + 对话文本附路径,模型经 read_file
> 查看——不动 RunTurn/帧协议/压缩,图片可被工具二次处理(裁剪/OCR/素材)。
> 三协议对齐:Anthropic 原生 tool_result 图片块;OpenAI Chat/Responses 的
> 工具结果不支持图片(协议限制),序列化层转"占位文本 + 合成 user 图片消息",
> 归一化历史仍是标准 tool_result 块,跨协议切模型一致。

- [x] provider:BlockImage/ImageSource/tool_result Blocks;anthropic 线格式转换;
      openai/openai_responses 降级转换(flattenToolResult)
- [x] tools:BlocksTool 接口;read_file 图片分支(解码/1568px 缩放/重编码,
      x/image 依赖;小图原字节直传);工具描述更新
- [x] loop:execToolUse 走 BlocksTool,单文本块压平;compact 摘要图片占位 [图片]
- [x] server:POST/GET /api/sessions/{id}/uploads(白名单/20MB 上限/防穿越/
      uploads/.gitignore 自免疫)
- [x] UI:composer 粘贴/拖拽(蒙层)→ 上传 → 缩略 chips(可移除)→ 发送拼
      [图片] 路径行;用户气泡缩略图 + 点击大图;排队兼容

## 验证

- [x] Go 单测:三协议 wire 形状 ×3、read_file 图片分支 ×4、上传路由(含防穿越)、
      集成(read_file 读图 → 图片块进入下一次 LLM 请求历史);全量 go test 通过
- [x] UI 端到端(无头 Chromium):拖入 PNG → chip → 发送 → 气泡缩略图加载成功
      (naturalWidth=100)→ 文件落盘 .mc-agent/uploads/ + .gitignore;无 console 错误
- [ ] 真实视觉模型冒烟(本机无可用 vision key,待网关 key 后补)

# 修复+增强:壳内拖拽失效 + 附件放开为任意文件(2026-07-16)

> 用户反馈:粘贴可用但拖拽不行;且希望能传文件。
> 拖拽根因:Tauri 默认原生 drag-drop 处理器在窗口层吞掉文件拖拽,
> HTML5 drop 事件到不了页面(无头浏览器测试无壳,故未暴露)。

- [x] 壳:WebviewWindowBuilder.disable_drag_drop_handler()
- [x] 内核:上传路由放开任意类型;保留清洗后的原始文件名(路径穿越清洗、
      重名序号、空名回退时间戳);GET 非图片按 octet-stream + attachment
      下发(防 html 同源渲染执行)
- [x] UI:粘贴/拖拽收所有文件;非图片渲染文件名 chip;气泡 [文件] 行渲染
      可下载 chip;[图片]/[文件] 前缀区分

## 验证

- [x] go test 全绿(上传测试改为任意类型 + 原名保留 + octet-stream + 穿越清洗)
- [x] 无头端到端:同时拖入 PNG + "启动日志 v2.log" → 双 chips → 发送 →
      气泡缩略图 + 文件 chip → 工作区两文件落盘(原名保留)
- [ ] 壳内拖拽待真机回归(disable_drag_drop_handler 需重新打包)

# 增强:模型视觉能力门禁(2026-07-16)

> 用户看到请求里的大段 base64 质疑可用性。base64 内嵌本身是多模态 API 的
> 标准形态(API 入口解码,不进文本 token);真正的问题是非视觉模型收到
> image 块的行为不可控(网关报错或把 base64 当文本烧 token)。

- [x] config.ModelProfile 加 vision 字段(缺省 false = 安全默认不发图)
- [x] loop:Options.Vision + SetVision;非视觉模型的图片块降级为文本占位
      (提示去设置开启或用工具按路径处理)
- [x] server/serve:ModelVision 接线(镜像 ContextBudget 模式),切模型同步
- [x] 设置 UI:模型卡"支持图片"勾选框
- [x] 测试:vision 模型图片块进下次请求(原集成测试加标记);非 vision 模型
      得到占位文本且无图片块;全量 go test + tsc + 构建通过

# 偿债:agent/ui 架构三项(2026-07-16)

> 评审结论:reduce.ts 零测试、App.tsx→ChatView 22 个 props 钻透、
> 重复内联样式无复用机制。三项全做,协议层行为不变。

- [x] 1. reduce.ts 补单测(vitest)
  - [x] b64/frameData 纯函数从 client.ts 抽到 codec.ts(client.ts 顶层有
        location/prompt 副作用,node 环境不可导入;分层也更干净)
  - [x] vitest 装入 devDependencies + test script
  - [x] reduce.test.ts:24 例——流式聚合、工具生命周期、进度窗口(MAX_FEED)、
        计划卡原地更新、审批状态机、user-input 解码、task-error、
        usage/model/permMode 回写、批量归约、未知帧透传
- [x] 2. 会话状态收进 useSession hook,解掉 ChatView props 钻透
  - [x] src/useSession.ts:WS 连接、chat 归约、composer(input/queued/atts)、
        模型/权限切换、改动查询统一收口(SessionHandle 句柄)
  - [x] ChatView 22 props → 8(meta/session/models/currentModel + 4 个布局回调)
  - [x] App.tsx 只留布局切换、App 级浮层、新任务表单(652 → ~450 行)
- [x] 3. 重复内联样式抽 CSS class(styles.css)
  - [x] .ellipsis/.icon-btn/.backdrop/.pop/.menu-item/.card(-lg)/.spinner;
        chat/sidebar/newtask/settings/components/App 六文件替换使用点,
        删掉 menuItem×2/iconBtn/dropdownItem/cardStyle/card 六个重复常量
  - [x] 一次性数值仍内联(不破坏"数值对应设计稿"的约定)
- [x] 4. 验证:vitest 24/24 绿;tsc + vite build 过(uidist 已更新);
        go build ./... 过;serve 冒烟(healthz / 内嵌 UI / REST 会话列表)正常

## Review(偿债三项)

- 新增 codec.ts(纯编解码)、useSession.ts(会话句柄)、reduce.test.ts;
  行为不变的收口重构,协议层 client/reduce 未动逻辑。
- 遗留:newtask 文件夹下拉原先无入场动画,统一 .pop 后带 mcin .15s(视觉
  微调,与其余菜单一致);设置页 input/select/whiteBtn 本就是单点常量,未动。
- 追加(2026-07-17):颜色令牌化收尾——46 处内联字面量并入 :root 语义令牌,
  预埋 [data-theme="dark"] 空壳与 Chromium 109/Win7 兼容红线注释(禁
  color-mix/相对颜色/嵌套/light-dark,透明变体独立令牌)。
- 提交前 8 视角 review:3 个正确性视角零 bug;修掉 10 项——call-response
  坏载荷挂 15s、connected 字符串推导误翻断线、lastSession 键两处硬编码、
  齿轮激活底/分隔点/禁用态三处设计稿色值保真(--accBg2/--t7/--tDis)、
  --track/--segBg 改 var() 引用、--shadowZoom 并入 --shadowLg、侧栏分隔
  线归 --line、openSession 去掉无谓 useCallback+eslint-disable。
- 后续可选:SessionViewer 复用只读帧流核(useFrameStream 方向);
  useSession 的 model/yolo 镜像 state 可派生化;basename 三处同型逻辑
  下沉公共模块(注意 Windows 反斜杠路径);深色模式落地时样式原语已就位。

# 功能:百智云登录 + 模型/MCP 自动同步(2026-07-17)

## 背景与结论

- 不改 MonkeyCode 后端,桌面直接对接 baizhi.cloud(移动端同源方案)。
- 登录协议移动端已完整逆好:Cap.js PoW 验证码(`mobile/src/api/captcha.ts`,算法与服务端 go-cap 对齐)
  + 手机验证码登录(`mobile/src/api/baizhi.ts`:challenge/redeem → phone_code → login/phone → cookie 会话)。
- 拿到 cookie 后可访问 `ai-api-gateway.app.baizhi.cloud`(模型)与
  `agent-toolkit.app.baizhi.cloud`(MCP),自动同步模型与 MCP 配置。
- 两服务 API 形态未测绘(无 cookie 时全 401,仓库内无对接痕迹)→ 阶段 0 先侦察。

## 架构决策

- **壳零改动**:配置所有权仍在壳;登录与同步全部落在内核 + 内核 UI。
- **内核代理一切 baizhi 流量**:UI 跑在 127.0.0.1 origin,对 baizhi.cloud 带凭证跨域会被 CORS 拦;
  Go 客户端无此约束。内核在本地 HTTP 上暴露 /api/baizhi/*。
- **同步产物写入 models.json/mcp.json**:UI 拿内核返回的清单合并进设置表单,
  走现有 save_config → 壳落盘 → 重启内核。条目打来源标记(source=baizhi),
  再次同步只增量更新/清理自家条目,不碰手工条目。
- **产品形态:一次性向导**:登录一次换出长期凭证进配置,之后不依赖登录态;
  cookie 持久化(0600)仅供"重新同步",过期引导重登。

## 阶段 0:API 侦察(部分完成;字段结构待真实 cookie)

三地址私有化可配(用户纠正):账号域 / 模型网关 / MCP 网关独立配置,
默认官方云,已落 `internal/baizhi/endpoints.go`
(环境变量 MC_AGENT_BAIZHI_URL / _MODEL_GATEWAY / _MCP_GATEWAY)。

无 cookie 侦察结论(从公开前端 bundle + 状态码探测):
- 两网关都是长亭自研 SPA,与 baizhi.cloud 共享 `sl-session`(SameSite=None),
  疑似统一 SSO;**网关层统一 401**(连不存在路径也 401),端点存在性无法靠探测区分
- **ai-api-gateway(模型)REST 契约已从 bundle 挖到**:
  - `GET /api/console/api-keys?page&pageSize` 列 key;`POST /api/console/api-keys` 建 key;
    `POST /api/console/api-keys/{id}/rotate` 轮换(暗示密钥可能仅建/轮换时明文返回)
  - `GET /api/console/models?…` 列模型;`GET /api/console/providers`;`GET /api/console/me`
  - 推理 base_url = `<网关>/api/openai`(chat/completions、responses)与 `/api/anthropic`(v1/messages),
    与移动端 ai-models.app.baizhi.cloud、Web model-square 同构
- **agent-toolkit(MCP)契约未知**:bundle 深度 minify,API 路径运行时拼接、
  前端路由仅见 apps/services/api-keys/usage;需真实 cookie 抓包

- [x] 账号域可配 + 两网关地址可配(私有化)
- [x] ai-api-gateway REST 端点路径与分页形态测绘
- [x] ~~需真实 cookie~~ 已实测(见阶段 2):api-keys 列表仅掩码、POST 创建才给明文;
      models 字段确认;登录 cookie 直接可用于网关(baizhi_session 域 cookie + 网关自发 sl-session)
- [x] agent-toolkit MCP 端点与响应结构(bundle 测绘完成;真实响应待团队开通权限)

## 阶段 1:内核 baizhi 客户端 ✅

- [x] `agent/internal/baizhi`:Cap.js PoW 求解器(黄金值由移动端 JS 实现生成,钉住跨实现一致性)
- [x] 登录客户端:challenge/redeem → phone_code → login/phone;cookie 存储自实现
      (RFC 6265 域后缀/路径匹配,Domain 不匹配请求 host 时降级 host-only),0600 落盘、重启恢复
- [x] serve 本地路由:/api/baizhi/send-code /login /status /logout;
      server 经 Options.AuthRoutes 钩子挂载,对业务零知识
- [x] 假服务端 e2e:发码→登录→status(profile)→内核重启恢复→登出全链路验证
- [x] 微信扫码登录:内核扮演 qrconnect 页面(网页版微信同款协议)——
      oauth/login?platform=wechat → 解析授权页二维码 uuid → 长轮询
      lp.open.weixin.qq.com(408 待扫/404 已扫/403 取消/402|500 过期/405 出码)
      → 带 cookie jar 走百智云回调换会话;/api/baizhi/wechat/{start,poll};
      真实环境无头冒烟通过(真二维码 + waiting),仅"扫码确认→回调"待真机验证
- 侦察发现(误连真实 baizhi.cloud 顺带确认):challenge 端点返回 **HTTP 201**
  (已按 2xx 判成功,对齐移动端 res.ok);匿名会话 cookie 名 `sl-session`(host-only+secure)

## 阶段 2:同步 ✅(2026-07-17 真机测绘重写 + 真机 e2e 通过)

> 推翻此前"切个人 space"方案:真机 `GET /api/console/spaces` → 404,console API
> 是**扁平**的,团队 space 会话可直接列模型/管密钥,无切换概念。

模型网关(ai-api-gateway)真机契约(全部带真实 cookie 实测):
- `GET /api/console/models?page&pageSize` → items{name,interfaceType,enabled,healthStatus,…}
- `GET /api/console/api-keys` → 仅 maskedKey 掩码;**明文只在创建时返回一次**
- `POST /api/console/api-keys {name}` → data{id,key(明文),enabled:**false**(默认停用)}
- `PATCH /api/console/api-keys/{id} {name,enabled}` 启用(name 必填,否则 400)
- 推理 base_url:`<网关>/api/anthropic`(x-api-key)/ `<网关>/api/openai`(Bearer),
  双协议真机推理冒烟 200;`/api/console/me` 返回 spaceId/isTeam
- 探测所建临时 key 均已删除(DELETE /api/console/api-keys/{id} 可用)

MCP 网关(agent-toolkit)契约(子代理挖前端 bundle;本账号团队未开通 app_id=39,
`/api/v1/*` 一律 302 权限申请页,响应结构待有权限账号复核):
- 管理 API 同源 `/api/v1/*`,cookie 鉴权;包壳 code 为字符串 "ok";
  **每 host 独立 sl-session**(先 GET / 领取)
- `GET /api/v1/services`(catalog_code)/ `GET /api/v1/api-keys`(masked_key,status)/
  `GET /api/v1/api-keys/{id}/reveal` → **明文可随时取回** / `POST /api/v1/api-keys
  {name,tool_codes}` / `POST /api/v1/api-keys/{id}/enable`
- 运行时**单端点** `<MCP 网关>/mcp`(Streamable HTTP,Authorization: Bearer)→
  mcp.json 只产出一个条目(baizhi-toolkit)

- [x] `sync.go` 重写:扁平 API;密钥策略=known_keys 掩码前后缀匹配复用(停用先
      PATCH 重启用)→ 都对不上才新建"MonkeyCode"并启用;MCP=握手→services→
      ensureMCPKey(reveal 优先/只重启用自家同名/新建授权全部 tool_codes)→单条目
- [x] 密钥名全局唯一(真机 409"名称已存在",用户桌面同步已建 MonkeyCode 后
      浏览器端撞名 502 复现):pickKeyName 从列表选不冲突名(MonkeyCode-N),
      不动同名旧 key(明文可能在别的设备用);SyncResult 带 key_name 供 UI 展示
- [x] `POST /api/baizhi/sync` 收 {known_keys};UI 传设置表单现有 sk- 密钥,
      结果按名合并(不删手工条目),key_created/key_name 提示新建
- [x] 单测 8 例:新建+启用(PATCH 带 name)/复用/停用重启用/撞名换名/掩码匹配/
      MCP reveal/MCP 新建 tool_codes/未开通 302 优雅降级
- [x] **真机 e2e**(真实 cookie + 真内核 serve):46 模型拉回、known_keys 复用不新建、
      base_url/协议映射正确、MCP 未开通降级 note;账号零残留
- [ ] MCP 真实数据复核(阻塞:团队需开通 Agent 工具包,或换已开通账号跑一次同步)
- [ ] 源标记:HostModel 无 source 字段,当前按"同名覆盖"合并;若要"重同步清理旧条目"需加 source

## 阶段 3:UI(agent/ui 设置视图)

- [x] 百智云账号卡片:微信扫码(默认,自动拉码 + 状态提示 + 过期重取)/
      手机验证码(60s 倒计时)双模式;已登录态展示 + 登出;设置视图新增「百智云账号」段
- [x] 同步结果挑选面板(2026-07-17,用户反馈"不能选"):同步结果先进勾选列表
      (已在表单的同名条目默认勾选=重同步刷新,新条目手动挑;全选/清空;MCP 独立
      开关;notes 面板内展示)→「导入所选」才合并进表单;无头 Chromium 实测
      (46 模型面板/勾选计数/导入文案含实际密钥名)
- [ ] 登录成功 → 自动 sync → 同步结果预览 → 确认合并 → save_config 保存重启(等阶段 0/2)

## 阶段 4:验证

- [ ] 真机全链路:登录 → 同步 → 用同步模型建会话跑任务;MCP 工具会话内可用
- [ ] 坏路径:验证码错误、cookie 过期、同步 401、风控拦截 → 明确报错可重试,不致死

# 模型来源分组 + 独立设置窗口(2026-07-17,用户反馈)✅

> 反馈:① 同步的几十个模型平铺淹没设置页与模型下拉,应作为一个分组;
> ② 设置页经常被意外退回(根因:全局 Esc 无输入守卫,表单里按 Esc 冒泡退出;
> 次因:保存后整页重载回默认视图)。方向拍板:设置改独立窗口。
> 计划:~/.claude/plans/ticklish-sparking-kay.md(已批准)。

## source 分组贯通

- [x] 数据层:ModelProfile/server.ModelInfo/UI 类型加 source(omitempty 纯增量,
      会话绑定仍按 name;壳 opaque 透传零改动);serve ListModels 组装补 Source
- [x] 设置页:模型卡分两节——手工平铺 +「百智云(N)」折叠分节(默认收起,
      导入后自动展开供核对);modelCard 抽函数,回调恒用真实数组索引
- [x] ModelPicker(新任务/状态栏共用):按来源分桶(自定义前、百智云后,节头
      小标题),弹层 maxHeight 320 滚动;>10 个模型时顶部过滤框;menuModels
      下线模型兜底项归自定义组
- [x] 同步导入语义:applySynced 补回被丢弃的 source;改"替换 baizhi 组"——
      手工条目保留、百智云组整体替换为勾选集合(取消勾选即清理);默认模型
      按名重定位;挑选面板预勾选改为"表单里 source=baizhi 的同名条目"

## Esc 意外退出修复

- [x] App 全局 Esc:settings 退出分支加输入守卫(INPUT/TEXTAREA 内只 blur);
      独立设置窗口的 Esc 同守卫(非输入态关窗)

## 独立设置窗口(同一内核 React UI,不分裂技术栈)

- [x] 壳:KernelUrl managed state(M2.13 删除的模式复活,setup/save_config 两处
      写入);open_settings_window 命令 + open_settings(存在聚焦/否则建
      "settings" 窗口加载 当前URL&view=settings#token,原生装饰,共用导航守卫
      is_internal_url);托盘「设置」改开独立窗口;save_config 重启后设置窗口
      一并导航到新令牌 URL 并夺回焦点
- [x] ACL:kernel-ui capability windows 加 "settings";build.rs 命令清单 +
      allow-open-settings-window(远程源自定义命令须显式授权,bb1574e 教训)
- [x] UI:main.tsx 按 ?view=settings 分流 → SettingsWindow(全屏设置视图,
      不建 WS/不恢复会话,返回/Esc 关窗);client.ts openHostSettings/
      isSettingsWindow;⚙ 桌面壳开独立窗口、浏览器模式回退页内视图;
      首启零模型向导维持页内(main 窗口)

## 验证

- [x] agent:go test 全量 + vet 过(source 透传/api-models 断言新用例);
      UI tsc + vitest 24 例 + build(uidist 入库)
- [x] 无头 Chromium(真 serve + 带 source 清单):下拉分组节头与顺序、
      13 模型出过滤框且过滤生效、?view=settings 只渲染设置视图(无侧栏)、
      设置页百智云节 2→5 卡折叠展开、Esc 输入框内不退出/非输入关窗、
      ⚙ 调 open_settings_window 且不切页内视图;截图核对
- [x] 壳:cargo build 过;xvfb+dbus 无头端到端(隔离 XDG_CONFIG_HOME):
      设置窗口以 view=settings 创建、其 remote ACL 生效(settings-invoke-ok)、
      save_config 重启后双窗口都换新 boot URL、nav-guard/save-reload 回归全过
- [ ] Mac/Win 真机人工:托盘「设置」、⚙ 开窗、保存后设置窗口存活且 main 刷新

## 提交前 review(8 角度 × 逐项验证)修复 10 项

- [x] **Windows 死锁**:open_settings_window 同步命令建窗会死锁(tauri doc 明示,wry#583)→ 改 async
- [x] **MCP-only 导入清空模型组**:勾 0 模型只导 MCP 时替换语义把已有 baizhi 组删光
      (模型改名场景不点清空也触发)→ applySynced 对空模型集只并 MCP 不动模型组
- [x] **Esc 误拒审批**(存量,同函数内):deny 分支补 typing(blur)/SELECT/isComposing/
      !isNewView 四重守卫(Enter 分支本有,恢复对称);settings 分支共用
- [x] **KernelUrl 陈死白窗**:save 重启失败后旧 URL 未清 → stop_kernel 时同步 take(),
      失败态落回 show_any_window 回退
- [x] **设置窗 Esc 丢未保存编辑**:挑选面板捕获相先消费 Esc(只关面板);窗口守卫补 SELECT
- [x] **存量无 source 条目兼容**:预勾选放宽为"baizhi 或无 source 的同名条目"
      (旧版同步落盘的条目重同步即迁移归组)
- [x] **折叠分节吞默认标记**:加载时默认模型在同步组则初始展开
- [x] 死代码:onHostEvent("open-settings") 监听 + client.ts helper 删除,README 同步更新
- [x] source 单一事实来源:types.ts SOURCE_BAIZHI + modelSourceLabel 共享(chat/settings
      复用),Go 侧 sourceBaizhi 常量,两侧注释互指
- [x] SettingsWindow 去掉自动 updateCheck(壳自检+主窗口已查,窗口关闭即销毁场景纯冗余)
- [x] 回归:go test/vet、tsc+vitest+build、cargo build 全过;无头 Chromium 分组冒烟全过;
      xvfb 壳端到端全链路(main 重载 saved=1 + reload-after-save-ok + 设置窗新 boot +
      settings-invoke-ok + focus 路径 + nav-guard)——期间修了探针自身时序伪影:
      外域导航测试与 save 整页导航交叠会被 WebKitGTK 吞掉后者,外显为"主窗口不重载"
      的假故障,测试延后到 +6s 错开

# 设置页重设计:账号优先 + 左导航 + 保存条 + 紧凑行(2026-07-17,用户反馈)✅

> 反馈三连:① 独立窗口还有「返回」(页内遗留);② 保存埋在长滚动底部不明显;
> ③ 分组后仍密密麻麻(46 模型 46 张大卡平铺)。产品定位确认:MonkeyCode 是百智云
> 旗下产品,账号优先(登录→同步为主路径)。计划:~/.claude/plans/ticklish-sparking-kay.md。

- [x] 拆分:settings-ui.tsx(共享表单原语)+ baizhi.tsx(BaizhiCard 迁出,登录态改受控);
      settings.tsx 重写为 SettingsShell
- [x] 左侧分类导航(百智云账号/模型/MCP/通用,默认账号页):复用 sidebar 选中态令牌
      (--accSel 底+--onAcc 字+500 字重),图标+文字;「返回」仅页内模式渲染(standalone
      独立窗口不渲染)——问题①
- [x] 脏状态保存条:payloadOf 归一化(save 与 dirty 比较同源)+ baseline/snapshot 快照;
      dirty 时底部浮现「有未保存的更改」+[放弃更改][保存];放弃从快照复原——问题②
- [x] 模型紧凑行 + 手风琴编辑:40px 行(名/provider 徽标/✓默认/hover 操作)点击行下展开
      现有编辑表单;百智云组在前(可折叠)+ 自定义组在后(高级路径,空态虚线卡);
      回调恒用真实索引(review 教训)——问题③
- [x] MCP 同款紧凑行 + 展开;新增即展开末行编辑
- [x] 账号优先:默认进账号页;模型/MCP 页未登录顶部引导条「去登录」;同步导入后自动切模型页;
      首启零模型落在账号登录引导(不再逼手工填模型)
- [x] dirty 关闭确认:SettingsWindow(Esc/onClose)+ App 页内(Esc/返回)dirty 时 confirm;
      输入态 Esc 仍先 blur(第二次才关);挑选面板捕获相/SELECT/MCP-only 守卫全保留
- [x] 壳设置窗口 760×720 → 900×660 + min 760×560(左导航需要横向空间)
- [x] 验证:tsc + vitest + build(uidist 入库)+ cargo build 全过;无头 Chromium——
      四分类页截图核对、8 紧凑行、展开编辑、改字段→保存条浮现→放弃复原、百智云组折叠 8→3、
      dirty+双击 Esc→confirm→关窗、浏览器页内有返回/独立窗口无返回/浏览器只读;
      xvfb 壳端到端(保存重启双窗口导航/settings ACL/nav-guard)全链路回归通过
