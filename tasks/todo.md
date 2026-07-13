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
- [ ] Windows ConPTY 实测(需 Windows 机器)、OAuth 登录后端对接(M2 剩余项)
