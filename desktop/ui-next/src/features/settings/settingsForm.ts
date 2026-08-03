// 设置表单的纯逻辑:草稿 ⇄ save_config 全量载荷、脏判定、校验。
// 与渲染无关(不引入 React),往返语义集中在此被单测直接盯住:
// - 模型字段白名单:未知/旧实验字段不透传,避免只写 config.json、物化时被
//   静默丢弃的"幽灵配置";白名单漏掉 locked/owner 会让锁定条目一次保存后
//   静默变可选,必须全列。
// - MCP 表单 ⇄ mcpServers(与内核 mcp.json 同构):表单未呈现的字段
//   (disabled 等)进 extra 原样往返,不因一次保存丢失。
// - 表单外的顶层字段(mc_* / 壳自有偏好)从载入的配置原样透传(全量写回)。
import type { DesktopConfig, HostModel } from "@/lib/ipc/config";

// ---- MCP 编辑模型与序列化 ----

export interface McpEntry {
  name: string;
  type: "http" | "stdio";
  url: string;
  command: string;
  args: string; // 空格分隔
  kv: string; // 每行 KEY=VALUE;http→headers,stdio→env
  /** 条目来源("baizhi" 同步等);随 mcp.json 落盘,内核忽略 */
  source?: string;
  /** 表单未呈现的其余字段:原样携带,保存时透传回 mcp.json 不丢失 */
  extra?: Record<string, unknown>;
}

/** serversToMcps 拆进表单字段的键;其余键进 extra 原样往返 */
const MCP_FORM_KEYS = new Set(["url", "command", "args", "env", "headers", "source"]);

/** MCP server 名会进入 mcp__<server>__<tool>,须满足模型工具名约束。 */
export const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function parseKV(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let n = 0;
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!k) continue;
    out[k] = line.slice(i + 1).trim();
    n++;
  }
  return n ? out : undefined;
}

const stringifyKV = (obj: unknown): string =>
  obj && typeof obj === "object"
    ? Object.entries(obj as Record<string, unknown>)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join("\n")
    : "";

/** 表单 → mcpServers:空名/缺 URL/缺命令的条目跳过(校验会先拦住有名字的)。 */
export function mcpsToServers(mcps: McpEntry[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of mcps) {
    const name = m.name.trim();
    if (!name) continue;
    // extra 先铺底(disabled 等表单外字段透传),表单字段覆盖;
    // source 随条目落盘(omitempty 语义,手工条目不带)
    const src = m.source ? { source: m.source } : {};
    if (m.type === "stdio") {
      if (!m.command.trim()) continue;
      const args = m.args.trim() ? m.args.trim().split(/\s+/) : undefined;
      out[name] = { ...m.extra, command: m.command.trim(), args, env: parseKV(m.kv), ...src };
    } else {
      if (!m.url.trim()) continue;
      out[name] = { ...m.extra, url: m.url.trim(), headers: parseKV(m.kv), ...src };
    }
  }
  return out;
}

export function serversToMcps(servers: Record<string, unknown>): McpEntry[] {
  return Object.entries(servers).map(([name, c]) => {
    const cfg = (c ?? {}) as Record<string, unknown>;
    const stdio = typeof cfg.command === "string" && cfg.command !== "";
    const extra = Object.fromEntries(Object.entries(cfg).filter(([k]) => !MCP_FORM_KEYS.has(k)));
    return {
      name,
      type: stdio ? ("stdio" as const) : ("http" as const),
      url: typeof cfg.url === "string" ? cfg.url : "",
      command: typeof cfg.command === "string" ? cfg.command : "",
      args: Array.isArray(cfg.args) ? cfg.args.map(String).join(" ") : "",
      kv: stringifyKV(stdio ? cfg.env : cfg.headers),
      source: typeof cfg.source === "string" ? cfg.source : undefined,
      extra: Object.keys(extra).length ? extra : undefined,
    };
  });
}

// ---- 草稿 ----

export interface SettingsDraft {
  models: HostModel[];
  /** 默认模型的行下标(载荷里重算 default 标记) */
  defaultIdx: number;
  mcps: McpEntry[];
  /** "" = 本机;"wsl:<发行版>" */
  kernelEnv: string;
}

export const emptyModel = (): HostModel => ({
  name: "",
  provider: "anthropic",
  base_url: "",
  api_key: "",
  model: "",
});

export const emptyMcp = (): McpEntry => ({ name: "", type: "http", url: "", command: "", args: "", kv: "" });

export function draftFromConfig(cfg: DesktopConfig): SettingsDraft {
  const models = (cfg.models ?? []).map((m) => ({ ...m }));
  const di = models.findIndex((m) => m.default);
  return {
    models,
    defaultIdx: di >= 0 ? di : 0,
    mcps: serversToMcps(cfg.mcp_servers ?? {}),
    kernelEnv: cfg.kernel_env ?? "",
  };
}

/** 全空的模型草稿行:不进载荷、不参与校验(加了行没填 = 没加)。 */
const isBlankModel = (m: HostModel): boolean =>
  !m.name.trim() && !m.base_url.trim() && !m.api_key && !m.model.trim();

const isBlankMcp = (e: McpEntry): boolean =>
  !e.name.trim() && !e.url.trim() && !e.command.trim() && !e.args.trim() && !e.kv.trim();

/** 草稿 → save_config 全量载荷:表单外的顶层字段(mc_* / 壳自有偏好)从
 *  base 原样透传;模型按白名单收敛并重算 default;MCP 序列化回 mcpServers。 */
export function buildPayload(base: DesktopConfig, draft: SettingsDraft): DesktopConfig {
  const models = draft.models
    .map((m, i) => ({ m, isDefault: i === draft.defaultIdx }))
    .filter(({ m }) => !isBlankModel(m))
    .map(({ m, isDefault }) => ({
      name: m.name.trim(),
      provider: m.provider,
      base_url: m.base_url,
      api_key: m.api_key,
      model: m.model,
      default: isDefault,
      context_window: m.context_window,
      max_output: m.max_output,
      think: m.think,
      vision: m.vision,
      source: m.source,
      locked: m.locked,
      owner: m.owner,
    }));
  return { ...base, models, mcp_servers: mcpsToServers(draft.mcps), kernel_env: draft.kernelEnv };
}

/** 脏判定:两份载荷都出自 buildPayload(同一 base、同样的键序),
 *  JSON 串比较即语义比较;undefined 字段序列化时自然脱落,两侧一致。 */
export function payloadEquals(a: DesktopConfig, b: DesktopConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- 保存前校验(首个错误即返回,保存条外显) ----

export type DraftError =
  | { kind: "modelName" }
  | { kind: "modelDup"; name: string }
  | { kind: "mcpName"; name: string }
  | { kind: "mcpDup"; name: string }
  | { kind: "mcpIncomplete"; name: string };

export function validateDraft(draft: SettingsDraft): DraftError | null {
  const modelNames = new Set<string>();
  for (const m of draft.models) {
    if (isBlankModel(m)) continue;
    const n = m.name.trim();
    if (!n) return { kind: "modelName" };
    if (modelNames.has(n)) return { kind: "modelDup", name: n };
    modelNames.add(n);
  }
  const mcpNames = new Set<string>();
  for (const e of draft.mcps) {
    if (isBlankMcp(e)) continue;
    const n = e.name.trim();
    if (!MCP_NAME_PATTERN.test(n)) return { kind: "mcpName", name: n };
    if (mcpNames.has(n)) return { kind: "mcpDup", name: n };
    mcpNames.add(n);
    // 有名字但序列化会被跳过的条目要拦下来,否则"保存成功"却静默丢条目
    if (e.type === "http" ? !e.url.trim() : !e.command.trim()) {
      return { kind: "mcpIncomplete", name: n };
    }
  }
  return null;
}
