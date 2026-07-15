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
