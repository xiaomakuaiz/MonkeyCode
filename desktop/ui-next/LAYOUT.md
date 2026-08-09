# ui-next 壳布局规范(Layout Contract)

> 布局先行:功能只能放进本规范的格子里。改格子=改本文件+对应实现,不许就地发明。

## 1. 层级(自底向上)
1. **窗体 chrome**:Windows/Linux = 32px 全宽窗框条(左端应用图标 + 右端 caption
   三键);mac = rail 左上角红绿灯(chrome 角落,**不画条**);浏览器 = 无。
   平台判据只有一个:`isCustomChromeShell()`(host.ts),别在组件里散写。
   > **不追求三端结构相同**(2026-08-08 定案):右边缘只有一条,让窗控与视图动作
   > 去抢,谁赢另一个都会被挤到中间当孤儿;mac 没这问题只因它的窗控在左边。
   > 该统一的是设计语言,结构随平台——mac 没有标题栏条是因为 macOS 窗口就没有。
   > 「把 caption 并进 52px 头带」的方案**已废弃,别再提**;视图动作三端一律
   > 留在主区头部最右缘。

   窗框条的三条铁律:
   - **不放品牌/视图信息**。曾摆过一份品牌,与紧挨其下的侧栏头凑成上下两行
     同样字样(2026-08-07 用户报障「两个 header」)。品牌法定位置只有侧栏头。
   - **不承列色**(2026-08-08 定案)。删掉品牌文字还不够:条按 rail/side/main
     复刻三列配色时,`base-200` 色块 y=0..36 紧贴着又一个 `base-200` 侧栏头,
     **那才是「两个 header」的真正成因**。当年保留分段是为了"不断色"——但
     窗框本来就该跟内容断开,为了不断色而让它假装成内容的延伸,恰恰是它冒充
     header 的原因。整条单色(`bg-base-300`),列宽令牌不许出现在条里。
   - **不带底边线**。有线就成了 header 基线。

   Linux 一并走 CSD(壳侧 `decorations(false)`):保留原生装饰栏的话,三端里
   唯一不受控的那端最显眼。代价是 WM 的 resize 边/右键标题菜单/部分平铺手势
   没了——resize 由 UI 侧边缘热区补(§8.1),右键菜单由 `window_system_menu`
   命令补(Windows;GTK 侧无对等 API)。
2. **全局横幅**:EngineBanner(引擎生命周期专用),chrome 之下、三列之上,全宽。
3. **三列内容**:rail(w-rail,bg-base-300)/ 侧栏(w-side,bg-base-200,border-e)/
   主区(flex-1,bg-base-100)。
4. **浮层**:菜单/模态/抽屉,z 序见 z-index 约定(backdrop<pop<drawer<lightbox<toast)。
5. **角落瞬态**:后台会话提醒 toast、全局下载 dock(右下)。

## 2. 头部基线
- 三列各自长出 **h-13(52px)** 头部,同高对齐成一条贯通线(border-b border-base-300);
  两行文字(标题+副标题)在 44px 里太挤,52px 是定稿高度(2026-08-04)。
- rail 顶 = 窗控角落(mac)或同高空位(**其余平台一律留,无例外**);侧栏头 =
  品牌名 + ＋新建(云端空间另有刷新钮);主区头 = 当前视图提供(欢迎页为空头带)。
  > 曾对 Windows 开特例不留这一格,让第一个空间图标顶上去占位:尺寸恰好凑得上
  > (size-11 + py-1 = 52px)所以没露馅,但三个图标整体比其余平台高一格,契约里
  > 也从没写过这条。2026-08-08 删除。
- 拖拽区分布在各头部空白处(data-tauri-drag-region;按钮与可双击标题除外)。
- **固定定位覆盖层的顶偏移一律读 `--chrome-h`**(app.css,按根节点
  `data-platform` 取 0 / 32px),不许各自手算平台偏移。FilesDrawer 抽屉、
  daisyUI `.modal`、角落 toast 都走这条。
  > 2026-08-08 根治:此前 FilesDrawer 写 `isWindowsShell() ? "top-9" : "top-0"`、
  > toast 另写死 `mt-13`——后者那个 52 是照 mac 算的,Windows 上基线在 84px、
  > 提醒却从 68px 起,z-50 压住主区头右侧的文件/⋯ 动作钮。同一笔账算两遍、
  > 错一遍,变量收口治的是这一**类**,不是那一个。

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
| **会话/任务状态** | **侧栏行尾状态点**(仅要紧态;词进 title/aria,见 §6) | 头部、独立列、行内文字 |
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
- **内容量可变的纵滚容器用 `[scrollbar-gutter:stable]` 预留滚条槽位**
  (2026-08-05 侧栏展开抖动的根因):chrome.css 自定义/标准化了滚条样式,
  内核即用经典布局型滚条(8px 挤占内容宽),auto 下滚条随折叠开合出现/
  消失,整列内容横移抖动。gutter 只预留空间不绘制,透容器底。
  **不用 `overflow-y-scroll` 常驻滚道**:壳内核走标准 scrollbar-width
  路径时忽略 ::-webkit-scrollbar 透明底,空滚道画成白条(同日用户报障,
  两轮定案);消息流居中列用 `stable both-edges` 对称留槽(中线对齐)。
- 横向滚动只允许出现在**专用滚动区**:代码块(pre)、diff/代码预览、markdown
  表格包裹层(.md-scroll)、xterm。

## 6. 侧栏内部结构(四段式;信息布局参考旧 UI,组件一律 daisyUI)
```
头部 h-13(固定):品牌 + ＋新建(云端加刷新)
概览块(固定,2026-08-04 用户定案):空间标题 + 一句描述 + 统计行
  (本地 = N 项目/N 任务,chat = N 对话,云端 = N 项目/N 任务;运行中
   primary/等待确认·排队中 warning 着色且仅 >0 时出现;云端 feed 由
   Sidebar 注入(useCloudTasks/useCloudProjects,enabled=仅云端空间),
   与列表同一份数据,首屏加载中不出统计行)
列表(flex-1,唯一滚动区,纵滚横截):menu menu-sm + details 折叠
footer(固定钉底):更新提示等常驻条,永不随列表滚动
```
> 搜索行已撤(用户指令 2026-08-04「搜索先去掉」);回归时恢复 input 行 +
> query 过滤 + 全折叠段强制展开(CloudTaskList 仍保留 query prop)。

### 6.1 行信息布局(用户定案 2026-08-04,二次定案「区块标签+安静行」;
载体 = menu 的 li>a)
- **行一律单行**:行首身份图标槽 + 主文案(**摘要优先**,缺席回落标题;
  标题进 tooltip)+ 行尾状态点殿后;云端行同构。**云端行尾点仅 error**
  (2026-08-06 用户定案):pending/processing 是云端任务的常态(VM 排队
  数分钟、执行数小时),常亮脉动点是噪音;运行/排队的一眼可见由概览
  统计行承担,状态词进行 tooltip。
- **安静行**:行首 12px 定宽槽固定显身份图标(本地 SquareTerminal /
  对话 MessageSquare / 云端 Cloud,/40;裸文字顶行首太秃,2026-08-05
  用户定案),**状态不顶掉身份图标**(2026-08-05 用户定案):要紧态 =
  行尾彩色状态点(等待确认 warning 脉动 / 运行中 primary 脉动 / 运行
  出错 error / 未读 attention warning),**文字状态词不上行**,进点的
  title/aria 与行 tooltip;静默态(N 轮/可继续/未开始/已完成)无点,
  轮次/终态词收进行 tooltip。**不展示时间**(用户定案)。
- 选中 = menu-active;attention(D3 未读)= warning 状态点 + bg-warning/10
  行淡底(功能性状态色,§8 白名单)。
- **已归档行降到 `/55`**(2026-08-07 对表旧 UI `--t4` 定案):归档行此前
  用正文色,在列表里和活跃任务一样抢眼(用户报障「已归档的任务标题怎么
  还是黑色的」)。活跃行不覆写、走正文色;选中态不降档——选中就该看清,
  颜色交回 `menu-active-fg`。
  > 同批试过的「行降到 `/90`、组头满色加粗」两项已按用户定案回退,
  > 只留归档这一档。
- **行菜单 = 右键**(lib/contextMenu,menu 皮相):重命名(行内 input,
  Enter 提交/Esc·失焦取消)/归档/删除;删除与云端终止走 confirm 二段。
  行 tooltip 给 标题/摘要/目录/「右键管理」。

### 6.2 分组与折叠(daisyUI details 原生折叠)
- 项目组头 = details summary,**区块标签形态**(定案 2026-08-04 二次;
  2026-08-07 试过换成旧 UI 的「同字号 + font-semibold + 满色」锚点形态,
  用户定案回退,**别再提**):summary 用 flex 覆写默认 grid,
  项目图标(Folder 12px /40)+ 名称
  (text-xs font-medium /50;**保留原大小写**——目录名是标识符,
  不做 uppercase,用户定案 2026-08-04)flex-1 伸展 + waiting 徽标 +
  快捷「+」殿后(常驻占位 hover 显形);**原生折叠箭头去掉**(after:hidden,
  用户定案 2026-08-04,开合只靠点击组头);同名项目不做展示名消歧
  (「父 · 名」前缀已撤,用户定案 2026-08-04,靠 tooltip 完整路径区分);
  组头可右键(在此新建任务/归档项目);HTML5 拖拽排序,dragover 落点
  border-t 指示线。
- **层级靠缩进 + 引导竖线,不靠空白**(2026-08-07 用户四轮报障后定案:
  ①「亲密性不够,像一路排下来」②「项目之间太空了」③「看看别人类似组件
  怎么设计的」④「间距还是不对…看看之前 UI 是咋搞的」)。
  间距只留旧 UI 同款的组尾 6px(`pb-1.5`,组内小节 `pb-1`)。
  > ④ 之后曾按旧 UI 把组头改成「比行更重」的锚点(旧 UI 正是这么表达从属:
  > 组头 12.5px/600/`--t1`、行 12.5px/400/`--t2`),**用户定案回退**——组头
  > 维持安静小标签,层级不靠字重。留档以免再走一遍;归档行降色那一档保留
  > (§6.1)。
  **空白分组这条路是错的,别再走**:
  > 对表主流树组件——VS Code 资源管理器、Finder 列表视图、JetBrains 项目树、
  > GitHub 文件树、Notion 侧栏——**无一例外是等距行 + 零组间空白**,层级
  > 只由「缩进 + 折叠箭头 + 引导竖线」三样表达。用空白分组是 Slack/Linear
  > 那类**少数几个固定分区**(Channels / DMs)的手法:分区数是常量才成立;
  > 项目组数量随用户增长,每组多摊几十像素,列表立刻被撑散(②即此)。
  > 中间两版先后试过 `mt-1→mt-4` 常驻组间距、`open:mb-4` 展开态组间距,
  > 都是在错的维度上找平衡,已废弃。
  实现:展开后的嵌套 `ul` 挂一条绝对定位的 1px 淡竖线(`listKit.GUIDE_L1/
  GUIDE_L2`,`bg-base-content/15`),`start` = 该层组头图标的中心横坐标
  (L1 = 基准内距 12px + 12px 图标的一半 = 18px;L2 = `ps-6` 24px + 10px
  图标的一半 = 29px),竖线正落在图标列上、文字在其右(VS Code 同款)。
  绝对定位不参与布局,行底照旧满宽。折叠的组没有嵌套 `ul`,自然无线——
  「有没有线」顺带成了折叠态的可见信号。三列表同取此件。
  > 三件套里的**折叠箭头这一件不采纳**(2026-08-07 复核后用户维持
  > 08-04 原定案):对表时它是主流树组件的标配(可点击 affordance +
  > 折叠态信号),已带方案征询,用户选择不加——行宽优先,折叠态由
  > 竖线有无间接表达。**别再以「主流都有」为由提第三次。**
- **缩进阶梯进行内、行底满宽**(2026-08-05 用户定案,含截图纠偏;推翻
  08-04「组内不缩进」与同日两版 margin 缩进):嵌套 ul 一律拉平
  (`ms-0 ps-0`——margin 缩进会把 hover/选中底压窄且各级左缘错位,截图
  事故根因);缩进用行内起始 padding:L1 行 `ps-6`、L2 行 `ps-9`(基准
  item padding 12px,每级恰 = 图标宽 12px);行首标记统一 12px 定宽槽
  (状态点/Archive/Folder 同列),同级文字对齐;层级链 = 项目头 → 任务行
  → 「已归档任务」小节头(Archive 图标行首、`after:hidden` 去尾箭头)→
  归档行;嵌套竖线**已恢复为引导竖线**(见上条,2026-08-07 推翻早前
  「按用户指令隐藏」);云端项目组同构(组 ul `[&>li>a]:ps-6`)。
- **折叠段内容收起即卸载**(条件渲染,不靠 details 原生隐藏):部分
  webview 里 details 收起后嵌套 ul 残留占位空间(2026-08-05 用户报障)。
- **三列表一套件,不做两套**(用户定案 2026-08-05,后续三空间并入同一
  tab 的横向双 tab):行/状态槽/区块标签/小节折叠收口在
  features/sidebar/listKit(ListRow/StatusSlot/GroupLabel/SectionFold),
  本地、对话、云端一律经它拼装,禁止各写一份行或组头。
- 归档/历史结构:项目内「已归档任务」小节;底部「已归档项目」;chat 底部
  「已归档会话」。云端与本地同构:进行中任务裸行置顶(同 chat 平铺行,
  **区标签 menu-title 已撤**)→ 项目组(Folder)→ 底部「历史任务」小节
  (History 图标)。「快速开始」组已撤(用户定案 2026-08-05:无项目的
  快速任务本就出现在进行中/历史里,分组视图是重复信息)。小节标签一律
  不带计数(用户定案 2026-08-05)。
- 折叠态持久化(旧 UI 契约键):mc.collapsedGroups / mc.sessionArchivesOpen
  (JSON string[])、mc.archivedOpen / mc.projectArchiveOpen /
  mc.cloudHistoryOpen("1"/"0",prefs.readFold/writeFold)。
- (搜索回归时)query 非空 → 全部折叠段强制展开、不写盘;云端未拉过的组
  顺势懒拉。
- menu 嵌套缩进竖线(li ul::before):2026-08-07 起**不再隐藏**,改由
  listKit 的 `GUIDE_L1/GUIDE_L2` 重新定位成引导竖线(见 §6.2 首条);
  早前的 `before:hidden` 指令已被该条取代。
- **hover 显隐铁律**:悬停才出现的元素不许插入布局(hidden→flex 会挤动
  同行内容形成抖动);只许 invisible→visible(常驻占位)或绝对定位。
- **menu 截断铁律**:daisyUI `.menu` 默认 `flex-flow: column wrap` + 自带
  nowrap——wrap 列的行宽跟内容走,truncate 不触发。**且 `.menu li` 自身
  也是 `column wrap`**(2026-08-04 溢出事故根因:只改顶层 ul 管不到行,
  嵌套行照样冲出行底)。列表级 menu 一律
  `w-full flex-nowrap [&_li]:flex-nowrap`,行内文字走 min-w-0+truncate 链。
  **浮层菜单(dropdown-content / contextMenu)同样适用**——定宽(w-64 等)
  替代 w-full,`[&_li]:flex-nowrap` 一个都不能少(2026-08-05 大纲面板
  时间被长摘要挤出即此因,行尾元素消失 = 先查这条)。

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
- **图标族 = `@tabler/icons-react`**(2026-08-07 由 lucide 换过来):组件名
  一律 `Icon` 前缀,线宽属性是 `stroke` 而非 `strokeWidth`(全库统一
  `stroke={1.75}`,组头 12px / 行内 13-14px / 空态 20px)。
  > 选图标两条:①**先确认是字形不是文字标记**——tabler 有一批画的是字母
  > (`IconJson` 就是「JSON」四个字),图集里清楚、12px 下糊成一团,必须
  > 按真实尺寸离屏出一版图再定;②**图标不能暗示不成立的前提**——如本地
  > 任务空间曾用 lucide 的 `FolderGit2`(带 git 分支的文件夹),而本地任务
  > 并不要求工作区是 git 仓库(FilesDrawer 专有非 git 降级分支),已换
  > `IconFolderCode`。

### 8.1 豁免清单(daisyUI 无对应形态,自绘保留;新增豁免须在此登记)
- TitleBar 的 Windows/Linux caption 三键 / mac 红绿灯:系统 chrome 规范(热区/
  配色/度量跟平台),btn 表达不了;§1 已归窗体 chrome 层。caption 键取
  **46×32 系统度量、直角通高触边**,与视图头部那排圆角内缩胶囊(btn-ghost
  btn-square btn-sm)形成形状对比——眼睛靠"贴不贴边"分组,不靠间距硬撑。
- ResizeEdges(Linux):窗口内侧 8 个透明拉伸热区(边 4px / 角 12px),
  `decorations(false)` 后 WM 的 resize 边没了,由它经 `start_resize_dragging`
  把拖拽交回壳。仅 Linux 渲染——Windows 的无边框 resize 由 tao 在 WM_NCHITTEST
  里做,mac 走 Overlay 保留原生窗体边;最大化时撤掉,免得误触屏幕边。
- `window_system_menu` 命令(Windows):无边框窗口丢掉的原生右键标题菜单,由
  窗框条右键与左端应用图标点击唤起。不走 WM_NCHITTEST/HTSYSMENU——WebView2
  子窗口铺满客户区,非客户区命中测试到不了 UI 这层。
  > **已知缺口**:同样因为客户区被 WebView2 占满,Windows 11 的 Snap Layouts
  > (悬停最大化键弹平铺菜单)拿不到,需要 `HTMAXBUTTON` 才会触发。这是自绘
  > caption 以来一直如此,不是本次回退。要补得在壳侧挂 WndProc 做
  > `WM_NCCALCSIZE` + `WM_NCHITTEST`(Chrome / Windows Terminal 的做法)。
- lib/contextMenu:命令式右键菜单按指针位定位,dropdown(锚定触发器)表达
  不了;皮相仍取 menu 文档形态(`menu bg-base-100 rounded-box shadow-sm`)。
- FilesDrawer 与 CloudTaskView 详情抽屉:daisyUI drawer 是 checkbox 驱动的
  整页布局原语,与受控开合+拖拽调宽不适配(FilesDrawer 头注 L1-4);面板
  自绘,scrim 用语义色 `bg-base-content/20`。
- xterm/term.css:第三方 canvas/DOM,吃不了主题变量且终端岛恒深色面
  (见 term.css 头注);仅限 xterm 本体,壳外皮相(终端卡)不豁免。
