# ui-next 壳布局规范(Layout Contract)

> 布局先行:功能只能放进本规范的格子里。改格子=改本文件+对应实现,不许就地发明。

## 1. 层级(自底向上)
1. **窗体 chrome**:Windows = 36px 全宽标题栏(caption 三键);mac = rail 左上角红绿灯
   (chrome 角落);Linux/浏览器 = 无。
2. **全局横幅**:EngineBanner(引擎生命周期专用),chrome 之下、三列之上,全宽。
3. **三列内容**:rail(w-rail,bg-base-300)/ 侧栏(w-side,bg-base-200,border-e)/
   主区(flex-1,bg-base-100)。
4. **浮层**:菜单/模态/抽屉,z 序见 z-index 约定(backdrop<pop<drawer<lightbox<toast)。
5. **角落瞬态**:后台会话提醒 toast、全局下载 dock(右下)。

## 2. 头部基线
- 三列各自长出 **h-13(52px)** 头部,同高对齐成一条贯通线(border-b border-base-300);
  两行文字(标题+副标题)在 44px 里太挤,52px 是定稿高度(2026-08-04)。
- rail 顶 = 窗控角落(mac)或同高空位;侧栏头 = 品牌名 + ＋新建(云端空间
  另有刷新钮);主区头 = 当前视图提供(欢迎页为空头带)。
- 拖拽区分布在各头部空白处(data-tauri-drag-region;按钮与可双击标题除外)。

## 3. 信息安放规则(每类信息只有一个法定位置)
| 信息 | 法定位置 | 禁止出现在 |
|---|---|---|
| 视图身份(标题/上下文路径) | 主区头部左侧 | — |
| 视图动作(文件/终端/⋯) | 主区头部右侧,图标钮 | — |
| 引擎崩溃/启动失败 | EngineBanner 全局横幅 | 任何头部 |
| **会话连接状态/恢复失败** | **主区头部之下的内嵌条**(恢复即消) | **头部** |
| 轮次/消息级错误 | 消息流内系统条目 | 头部、横幅 |
| 运行态(思考中/执行中/停止) | composer 上方状态行 | 头部 |
| 上下文用量 % | composer 底部集群右端 | 头部 |
| 模型/思考档/权限模式 | composer 底部集群左端 | 头部 |
| 任务清单(plan) | composer 上方面板 | 消息流 |
| 后台会话提醒 | 角落 toast + 侧栏行 attention(状态点放大加光晕) | 头部、消息流 |
| **会话/任务状态文字** | **侧栏行内状态尾注**(要紧态着色,静默态低调,见 §6) | 头部、独立列 |
| 更新可用 | 侧栏底部条 + 设置·关于 | 头部 |
| 下载进度 | 右下 dock | 头部、消息流 |

## 4. 主区视图形态
- 会话视图:头部 → (连接条) → 消息流(居中 max-w-3xl) → 面板/状态行 → composer。
- 设置/新建任务:视图级头部(标题+关闭)+ 居中内容列(max-w-2xl / max-w-xl);
  Esc 离开;点任何导航即切走(视图切换永远响应)。
- 云端任务视图与会话视图同构。

## 5. 滚动纪律
- **列/视图级滚动容器只许纵滚**:凡 `overflow-y-auto` 必须搭 `overflow-x-hidden`
  (CSS 规则:只写 overflow-y 时 overflow-x 会被计算为 auto,超宽内容即出横向
  滚动条——侧栏横滚事故的根因)。超宽内容靠 truncate/min-w-0 链截断。
- 横向滚动只允许出现在**专用滚动区**:代码块(pre)、diff/代码预览、markdown
  表格包裹层(.md-scroll)、xterm。

## 6. 侧栏内部结构(三段式;信息布局参考旧 UI,组件一律 daisyUI)
```
头部 h-13(固定):品牌 + ＋新建(云端加刷新)
列表(flex-1,唯一滚动区,纵滚横截):menu menu-sm + details 折叠
footer(固定钉底):更新提示等常驻条,永不随列表滚动
```
> 搜索行已撤(用户指令 2026-08-04「搜索先去掉」);回归时恢复 input 行 +
> query 过滤 + 全折叠段强制展开(CloudTaskList 仍保留 query prop)。

### 6.1 行信息布局(参考旧 UI;载体 = menu 的 li>a)
- 本地行两行式:标题行(标题 + 状态尾注)+ 引擎摘要行(text-xs /50,缺席
  不长);对话行恒单行(主行 = 摘要‖标题);云端行单行(标题 + 状态尾注)。
- 状态尾注(text-xs,max-w-16 截断,tabular):要紧态着色词(等待确认
  warning / 运行中 primary / 运行出错 error),静默态低调(N 轮/可继续/
  尚未开始/已停止/已完成,/50 与 /35 档);左端 status 状态点同色呼应。
  **不展示时间**(用户定案)。
- 选中 = menu-active;attention(D3 未读)= warning 状态点 + bg-warning/10
  行淡底(功能性状态色,§8 白名单)。
- **行菜单 = 右键**(lib/contextMenu,menu 皮相):重命名(行内 input,
  Enter 提交/Esc·失焦取消)/归档/删除;删除与云端终止走 confirm 二段。
  行 tooltip 给 标题/摘要/目录/「右键管理」。

### 6.2 分组与折叠(daisyUI details 原生折叠)
- 项目组头 = details summary:名称(text-xs font-medium /70)+ waiting
  徽标 + hover 快捷「+在此项目新建」;组头可右键(在此新建任务/归档项目);
  HTML5 拖拽排序,dragover 落点 border-t 指示线。
- 归档结构(旧 UI 同构):项目内「已归档任务 · N」小节;底部「已归档项目
  · N」;chat 底部「已归档会话 · N」。云端:「进行中」(menu-title 区标签)
  →「历史任务 · N」小节 →「项目」区(懒拉分组 + 快速开始)。
- 折叠态持久化(旧 UI 契约键):mc.collapsedGroups / mc.sessionArchivesOpen
  (JSON string[])、mc.archivedOpen / mc.projectArchiveOpen /
  mc.cloudHistoryOpen("1"/"0",prefs.readFold/writeFold)。
- (搜索回归时)query 非空 → 全部折叠段强制展开、不写盘;云端未拉过的组
  顺势懒拉。
- menu 嵌套缩进竖线(li ul::before)按用户指令隐藏:嵌套 ul 加 before:hidden。
- **hover 显隐铁律**:悬停才出现的元素不许插入布局(hidden→flex 会挤动
  同行内容形成抖动);只许 invisible→visible(常驻占位)或绝对定位。
- **menu 截断铁律**:daisyUI `.menu` 默认 `flex-flow: column wrap` + 自带
  nowrap——wrap 列的行宽跟内容走,truncate 不触发。列表级 menu 一律
  `w-full flex-nowrap`,行内文字走 min-w-0+truncate 链。

## 7. 拖拽区铁律(mac/Windows 自绘 chrome)
- Tauri 按**事件目标自身**是否带 `data-tauri-drag-region` 判定,**不继承**:
  头部容器带了没用,内部每个非交互子节点(标题 h1/副标题 p/占位 span/徽标)
  都必须单独带,否则子元素盖住的表面全部不可拖。
- 不带属性的例外:按钮等交互件、可双击重命名的文字 span(拖拽区双击会被
  吃成窗口最大化)。
- 新增头部时按本条自查;有 ChatView 结构测试可参照。

## 8. 阶段纪律:裸组件优先(用户指令,2026-08-04)
> 三层分治(同日教训):壳布局(本文件)/ 信息布局(可参考旧 UI)/ 组件
> 实现(一律 daisyUI 官方形态)——"参考旧 UI"只作用于中间层。
- 现阶段 daisyUI 组件一律用**官方文档形态**,不叠色彩/边线/阴影覆写
  (card 用 `card-border` 的 base-200 线;dropdown-content 用文档标准
  `menu bg-base-100 rounded-box shadow-sm`;激活态用 `menu-active/
  tab-active/btn-active` 原生类)。
- 统一视觉调整放到收尾,一次性经**主题变量**(monkeycode 主题块)完成,
  不散落在组件类上。
- 允许保留:功能性状态色(attention 行的 warning 淡底)、文字四档透明度
  (内容排版,非组件覆写)、布局结构线(列分界/头部基线)。
