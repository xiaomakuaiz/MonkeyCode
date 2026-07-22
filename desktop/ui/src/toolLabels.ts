/** 工具展示语言。当前产品默认中文;后续设置页可直接传入 "en"。 */
export type ToolLocale = "zh-CN" | "en";

export const DEFAULT_TOOL_LOCALE: ToolLocale = "zh-CN";

const ZH_TOOL_LABELS: Record<string, string> = {
  Agent: "子代理",
  Task: "子代理",
  AskUserQuestion: "向你提问",
  Bash: "执行命令",
  Cmd: "执行命令",
  PowerShell: "执行 PowerShell",
  SendUserMessage: "发送消息",
  Brief: "发送消息",
  Config: "修改配置",
  CronCreate: "创建定时任务",
  CronDelete: "删除定时任务",
  CronList: "查看定时任务",
  EnterPlanMode: "进入计划模式",
  ExitPlanMode: "退出计划模式",
  EnterWorktree: "进入独立工作区",
  ExitWorktree: "退出独立工作区",
  Edit: "编辑文件",
  Read: "读取文件",
  Write: "写入文件",
  Glob: "查找文件",
  Grep: "搜索内容",
  ListMcpResourcesTool: "查看 MCP 资源",
  ReadMcpResourceTool: "读取 MCP 资源",
  LSP: "代码分析",
  NotebookEdit: "编辑笔记本",
  RemoteTrigger: "管理远程触发器",
  SendMessage: "发送协作消息",
  Skill: "调用技能",
  StructuredOutput: "输出结构化结果",
  TaskCreate: "创建任务",
  TaskGet: "查看任务详情",
  TaskList: "查看任务列表",
  TaskOutput: "查看任务输出",
  AgentOutputTool: "查看代理输出",
  BashOutputTool: "查看命令输出",
  TaskStop: "停止后台任务",
  KillShell: "停止后台命令",
  TaskUpdate: "更新任务",
  TeamCreate: "创建代理团队",
  TeamDelete: "解散代理团队",
  TodoWrite: "更新任务计划",
  ToolSearch: "查找工具",
  WebFetch: "读取网页",
  WebSearch: "搜索网页",
  TestingPermission: "测试权限",
  mcp: "调用 MCP 工具",
};

const COMMON_WORDS: Record<string, string> = {
  create: "创建",
  add: "添加",
  get: "获取",
  read: "读取",
  fetch: "获取",
  list: "列出",
  search: "搜索",
  find: "查找",
  update: "更新",
  edit: "编辑",
  write: "写入",
  delete: "删除",
  remove: "移除",
  send: "发送",
  open: "打开",
  close: "关闭",
  run: "运行",
  issue: "事项",
  issues: "事项",
  pull: "拉取请求",
  request: "请求",
  requests: "请求",
  comment: "评论",
  comments: "评论",
  repository: "仓库",
  repositories: "仓库",
  branch: "分支",
  branches: "分支",
  file: "文件",
  files: "文件",
  user: "用户",
  users: "用户",
  message: "消息",
  messages: "消息",
};

const SERVICE_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  slack: "Slack",
  notion: "Notion",
  postgres: "PostgreSQL",
  filesystem: "文件系统",
  browser: "浏览器",
  playwright: "浏览器",
};

function identifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_./:-]+/)
    .filter(Boolean);
}

function readableIdentifier(value: string): string {
  return identifierWords(value)
    .map((word) => COMMON_WORDS[word.toLowerCase()] ?? word)
    .join(" ");
}

function mcpParts(tool: string): { service: string; operation: string } | null {
  const parts = tool.split("__");
  if (parts.length < 3 || parts[0].toLowerCase() !== "mcp") return null;
  return { service: parts[1], operation: parts.slice(2).join("_") };
}

export interface ToolTitleParts {
  /** 中文动作(或英文模式下的原始工具名) */
  action: string;
  /** 路径/命令/搜索词等原参数;未知工具会在这里保留可读名称 */
  target: string;
  /** 审计与 tooltip 使用的原始工具名 */
  rawTool: string;
}

export function localizeToolTitle(title: string, locale: ToolLocale = DEFAULT_TOOL_LOCALE): ToolTitleParts {
  const trimmed = title.trim();
  if (!trimmed) return { action: locale === "zh-CN" ? "调用工具" : "Tool", target: "", rawTool: "" };
  const split = trimmed.search(/\s/);
  const rawToken = split < 0 ? trimmed : trimmed.slice(0, split);
  const rawTool = rawToken.replace(/:+$/, "");
  const argument = split < 0 ? "" : trimmed.slice(split).trim();

  if (locale === "en") return { action: rawTool, target: argument, rawTool };

  const known = ZH_TOOL_LABELS[rawTool];
  if (known) return { action: known, target: argument, rawTool };

  // 已由上游产出中文标题时不再套“调用工具”前缀。
  if (/[\u3400-\u9fff]/.test(rawTool)) return { action: rawTool, target: argument, rawTool };

  const mcp = mcpParts(rawTool);
  if (mcp) {
    const service = SERVICE_LABELS[mcp.service.toLowerCase()] ?? readableIdentifier(mcp.service);
    const operation = readableIdentifier(mcp.operation);
    return {
      action: `调用 ${service}`,
      target: [operation, argument].filter(Boolean).join(" "),
      rawTool,
    };
  }

  return {
    action: "调用工具",
    target: [readableIdentifier(rawTool), argument].filter(Boolean).join(" "),
    rawTool,
  };
}

export function toolDisplayName(tool: string, locale: ToolLocale = DEFAULT_TOOL_LOCALE): string {
  return localizeToolTitle(tool, locale).action;
}

export function localizedToolTitleText(title: string, locale: ToolLocale = DEFAULT_TOOL_LOCALE): string {
  const { action, target } = localizeToolTitle(title, locale);
  return target ? `${action} ${target}` : action;
}
