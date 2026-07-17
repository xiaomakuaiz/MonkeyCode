// 与内核帧协议(internal/frame)对齐的类型定义。

/** GET /api/models 返回的可选模型 */
export interface ModelInfo {
  name: string;
  default: boolean;
}

/** 壳持有的应用配置里的一个模型条目(设置视图编辑,壳原样写盘、内核消费)。 */
export interface HostModel {
  name: string;
  provider: string; // anthropic | openai | openai_responses
  base_url: string;
  api_key: string;
  model: string;
  default?: boolean;
  /** 上下文窗口(token),高级项;缺省内核按 200k 处理 */
  context_window?: number;
  /** 支持图片输入(视觉);未勾选时读图降级为文本占位,不发图片块 */
  vision?: boolean;
  /** 跳过 TLS 证书校验(不安全,仅自签名内网网关),高级项 */
  skip_tls_verify?: boolean;
}

/** 壳持有的应用配置(经 Tauri IPC get_config/save_config 读写)。 */
export interface HostConfig {
  models: HostModel[];
  /** MCP 服务器(name → 配置,与内核 mcp.json 的 mcpServers 同构) */
  mcp_servers: Record<string, unknown>;
}

/** GET /api/sessions 返回的会话元信息 */
export interface SessionMeta {
  id: string;
  title: string;
  workdir: string;
  model: string;
  /** 权限模式("yolo" 全放行;缺省 = default) */
  mode?: string;
  turns: number;
  status: string; // created | running | finished | interrupted | error
  updated_at?: string;
  worktree?: { repo?: string };
  /** 归档标记:移出常规列表,折叠到「已归档」组 */
  archived?: boolean;
}

/** WS 下行帧(data 为 base64(JSON)) */
export interface Frame {
  type: string;
  kind?: string;
  data?: string;
  seq?: number;
  timestamp?: number;
}

/** task-running 帧内的 ACP 风格 sessionUpdate */
export interface AcpUpdate {
  sessionUpdate: string;
  content?: { text?: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawOutput?: unknown;
  entries?: PlanEntry[];
  attempt?: number;
  message?: string;
  used?: number;
  size?: number;
  progress?: ToolProgress;
  model?: string;
  mode?: string;
}

/** tool_call_update{status:in_progress} 的执行期进度载荷 */
export interface ToolProgress {
  kind: string; // subagent_tool | subagent_text | output | child_session
  id?: string;
  title?: string;
  status?: string; // run | ok | fail
  line?: string;
  childSessionId?: string;
}

/** 子代理进度窗口的一条:工具步骤或回复文本行(按时间混排,挂在 task 工具行下) */
export type SubEntry =
  | { kind: "tool"; id: string; title: string; status: "run" | "ok" | "fail" }
  | { kind: "text"; text: string };

export interface PlanEntry {
  content: string;
  status: string; // pending | in_progress | completed
}

export type PermOutcome = "approved" | "denied" | "timeout" | "cancelled";
export type PermState = "open" | "allowed" | "rejected" | PermOutcome | "expired";

/** 对话流里的一条渲染项 */
export type LogItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | {
      kind: "tool";
      tcId: string;
      title: string;
      status: "run" | "ok" | "fail";
      out: string;
      /** 子代理进度窗口(工具步骤 + 回复文本行,时间序) */
      feed?: SubEntry[];
      /** 最新输出行(kind=output 进度,如 bash 长命令) */
      lastLine?: string;
      /** 子代理子会话 ID(可打开完整回放) */
      childSessionId?: string;
    }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "sys"; text: string; error?: boolean }
  | { kind: "perm"; id: string; title: string; tool: string; state: PermState };

export interface FileChange {
  status: "A" | "M" | "D";
  path: string;
}

/** repo_file_list 返回的目录项(单层,目录在前已排序) */
export interface FileEntry {
  name: string;
  /** 相对工作区路径(正斜杠) */
  path: string;
  is_dir: boolean;
  size: number;
}

/** 待发送附件(已上传到会话工作区) */
export interface Attachment {
  path: string;
  name: string;
  isImage: boolean;
  /** 图片的本地预览(dataURL);非图片无 */
  preview?: string;
}

export interface Usage {
  used: number;
  size: number;
}
