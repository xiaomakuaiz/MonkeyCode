// 中文词典:键的唯一权威(en.ts 按本表的 key 全集补齐,漏译过不了 typecheck)。
// 键名按「域.用途」组织;插值用 {name} 占位。
export const zh = {
  "app.name": "MonkeyCode",

  "titlebar.minimize": "最小化",
  "titlebar.maximize": "最大化",
  "titlebar.restore": "还原",
  "titlebar.close": "关闭",
  "titlebar.zoom": "缩放",

  "rail.label": "空间导航",
  "rail.local": "本地会话",
  "rail.cloud": "云端任务",
  "rail.chat": "对话",
  "rail.settings": "设置",

  "sidebar.label": "会话列表",
  "sidebar.search": "搜索会话",
  "sidebar.clearSearch": "清空搜索",
  "sidebar.newTask": "新建任务",
  "sidebar.archived": "已归档",
  "sidebar.archivedProjects": "已归档项目",
  "sidebar.empty.title": "还没有会话",
  "sidebar.empty.detail": "点击「新建任务」开始第一个任务。",
  "sidebar.noResults.title": "没有匹配的会话",
  "sidebar.noResults.detail": "换个关键词试试。",
  "sidebar.cloud.placeholder": "云端任务列表将在后续版本接入。",
  "sidebar.row.menu": "会话操作",
  "sidebar.row.archive": "归档",
  "sidebar.row.unarchive": "取消归档",
  "sidebar.row.delete": "删除",
  "sidebar.row.deleteConfirm": "确认删除",
  "sidebar.project.menu": "项目操作",
  "sidebar.project.archive": "归档项目",
  "sidebar.project.unarchive": "取消归档项目",

  "status.running": "运行中",
  "status.waitingAsk": "等待审批",
  "status.error": "出错",
  "status.idle": "可继续",

  "create.title": "新建任务",
  "create.workdir": "项目目录",
  "create.workdirPlaceholder": "选择或输入项目目录",
  "create.browse": "浏览…",
  "create.model": "模型",
  "create.kind.local": "本地会话",
  "create.kind.chat": "普通对话",
  "create.submit": "创建",
  "create.cancel": "取消",
  "create.error.workdirRequired": "请先选择项目目录",

  "main.welcome.title": "开始一个任务",
  "main.welcome.detail": "从左侧选择会话,或新建一个任务。",
  "main.session.placeholder": "会话「{title}」的聊天视图将在下一阶段接入。",
  "main.shellInfo": "壳 {version} · 引擎 {engine}",
  "main.engineNotReady": "未就绪",

  "settings.appearance.theme": "外观主题",
  "settings.appearance.language": "语言",
  "settings.appearance.hint": "切换立即生效并记在本机。",

  "downloads.cancel": "取消下载",
  "downloads.dismiss": "关闭",
  "downloads.progress": "下载进度",
  "downloads.reveal": "在文件管理器中显示",
  "downloads.failed": "下载失败:{reason}",
  "downloads.canceled": "已取消",

  "md.copy": "复制",
  "md.copied": "已复制",

  "chat.thought": "思考",
  "chat.permission": "审批",
  "chat.question": "提问",
  "chat.loadEarlier": "加载更早",
  "chat.composer": "消息输入",
  "chat.composerPlaceholder": "输入消息,Enter 发送,Shift+Enter 换行",
  "chat.send": "发送",
  "chat.contextUsage": "上下文用量",

  "engine.starting": "引擎启动中(第 {attempt} 次尝试)…",
  "engine.crashed": "引擎已崩溃:{detail}",
  "engine.failed": "引擎启动失败:{detail}",
  "engine.restart": "重启引擎",
  "engine.logs": "日志",

  "common.confirm": "确认",
  "common.cancel": "取消",
} as const;

export type MessageKey = keyof typeof zh;
