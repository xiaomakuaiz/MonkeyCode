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
  turns: number;
  status: string; // created | running | finished | interrupted | error
  updated_at?: string;
  worktree?: { repo?: string };
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
}

/** tool_call_update{status:in_progress} 的执行期进度载荷 */
export interface ToolProgress {
  kind: string; // subagent_tool | output | child_session
  id?: string;
  title?: string;
  status?: string; // run | ok | fail
  line?: string;
  childSessionId?: string;
}

/** 子代理进度子项(挂在 task 工具行下) */
export interface SubItem {
  id: string;
  title: string;
  status: "run" | "ok" | "fail";
}

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
      /** 子代理探索步骤(kind=subagent_tool 进度) */
      subItems?: SubItem[];
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

export interface Usage {
  used: number;
  size: number;
}
