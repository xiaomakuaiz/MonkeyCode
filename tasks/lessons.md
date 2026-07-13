# Lessons

## 2026-07-12 mc-agent M1

- **自研 agent 的编辑工具不会自动保证格式**:dogfood 首个任务中模型用 edit_file 做的替换缩进不规范(go vet 不报但 gofmt 报)。修法不是让工具自动格式化(会破坏非代码文件),而是在系统提示中明确"编辑后对改动文件跑格式化工具";后续两次 dogfood 验证有效。通用教训:agent 行为问题优先在提示层修,工具层兜底。
- **Go 中 `defer` 修改非命名返回值不生效**:evalResult 的耗时统计写在 defer 里但函数按值返回,用时恒为 0。需要 defer 写返回值时必须用命名返回值。
- **在临时目录跑 Go 构建判分要禁用 VCS stamping**:agent 在工作区内 git init 后,判分的 `go build` 因 VCS 状态读取失败报错(exit 128)。评测环境应 `GOFLAGS=-buildvcs=false`,且临时工作区应初始化为带首次提交的 git 仓库(更接近真实场景)。
- **协议对齐先于代码**:动手前先读了 mobile/messages/handler.ts,发现云端帧内载荷是 ACP 风格 sessionUpdate——内核直接讲同一词汇,M2 桌面 UI 可零改动复用现有渲染层。先侦察协议再写实现,避免了一次返工。
