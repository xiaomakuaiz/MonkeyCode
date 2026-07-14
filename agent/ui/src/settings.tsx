// 设置视图:模型清单 + MCP 服务器编辑。配置所有权在壳(写盘 0600/env 注入/
// 重启内核),本视图只负责渲染与编辑,经 Tauri IPC get_config/save_config 读写;
// 保存成功后壳会重启内核并把整个页面导航到新内核 URL(本组件随之卸载)。
// 样式约定与 App 一致:内联 + styles.css tokens,宽 588 卡片列。
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { getHostConfig, inDesktopShell, saveHostConfig } from "./client";
import { MONO } from "./components";
import type { HostModel } from "./types";

// ---- MCP 编辑模型与序列化(与内核 mcp.json 的 mcpServers 同构,壳不解释) ----

interface McpEntry {
  name: string;
  type: "http" | "stdio";
  url: string;
  command: string;
  args: string; // 空格分隔
  kv: string; // 每行 KEY=VALUE;http→headers,stdio→env
}

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

export function mcpsToServers(mcps: McpEntry[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of mcps) {
    const name = m.name.trim();
    if (!name) continue;
    if (m.type === "stdio") {
      if (!m.command.trim()) continue;
      const args = m.args.trim() ? m.args.trim().split(/\s+/) : undefined;
      out[name] = { command: m.command.trim(), args, env: parseKV(m.kv) };
    } else {
      if (!m.url.trim()) continue;
      out[name] = { url: m.url.trim(), headers: parseKV(m.kv) };
    }
  }
  return out;
}

function serversToMcps(servers: Record<string, unknown>): McpEntry[] {
  return Object.entries(servers).map(([name, c]) => {
    const cfg = (c ?? {}) as Record<string, unknown>;
    const stdio = typeof cfg.command === "string" && cfg.command !== "";
    return {
      name,
      type: stdio ? "stdio" : "http",
      url: typeof cfg.url === "string" ? cfg.url : "",
      command: typeof cfg.command === "string" ? cfg.command : "",
      args: Array.isArray(cfg.args) ? cfg.args.map(String).join(" ") : "",
      kv: stringifyKV(stdio ? cfg.env : cfg.headers),
    };
  });
}

// ---- 样式原语(对齐 App 的新建任务视图) ----

const card: CSSProperties = {
  width: 588,
  maxWidth: "100%",
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 16,
  padding: 18,
  boxSizing: "border-box",
};
const input: CSSProperties = {
  width: "100%",
  background: "var(--codeBg)",
  border: "1px solid var(--line)",
  borderRadius: 9,
  padding: "8px 11px",
  font: "11.5px " + MONO,
  color: "var(--t1)",
  outline: "none",
  minWidth: 0,
  boxSizing: "border-box",
};
const select: CSSProperties = {
  background: "var(--codeBg)",
  border: "1px solid var(--line)",
  borderRadius: 9,
  padding: "8px 8px",
  fontSize: 12,
  color: "var(--t1)",
  outline: "none",
  cursor: "pointer",
};
const btn: CSSProperties = {
  padding: "7px 14px",
  background: "var(--card2)",
  borderRadius: 9,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--t2)",
  whiteSpace: "nowrap",
  userSelect: "none",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--t4)", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const emptyModel = (): HostModel => ({
  name: "",
  provider: "anthropic",
  base_url: "",
  api_key: "",
  model: "",
});
const emptyMcp = (): McpEntry => ({ name: "", type: "http", url: "", command: "", args: "", kv: "" });

// ---- 设置视图 ----

export function SettingsView({ onClose }: { onClose: () => void }) {
  const desktop = inDesktopShell();
  const [models, setModels] = useState<HostModel[]>([]);
  const [defaultIdx, setDefaultIdx] = useState(0);
  const [mcps, setMcps] = useState<McpEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    getHostConfig()
      .then((cfg) => {
        const ms = cfg?.models ?? [];
        setModels(ms.length ? ms : [emptyModel()]);
        setDefaultIdx(Math.max(0, ms.findIndex((m) => m.default)));
        setMcps(serversToMcps(cfg?.mcp_servers ?? {}));
        setLoaded(true);
      })
      .catch((e) => setErr("读取配置失败: " + (e instanceof Error ? e.message : String(e))));
  }, [desktop]);

  const patchModel = (i: number, patch: Partial<HostModel>) =>
    setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const patchMcp = (i: number, patch: Partial<McpEntry>) =>
    setMcps((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  const save = async () => {
    // UX 前置校验;权威校验在内核 LoadModels(重复名/provider 白名单等)
    for (const m of models) {
      if (!m.name.trim() || !m.base_url.trim() || !m.api_key.trim() || !m.model.trim()) {
        setErr(`模型「${m.name.trim() || "未命名"}」信息不完整(需名称/接口地址/API Key/模型标识)`);
        return;
      }
    }
    const names = new Set<string>();
    for (const m of models) {
      if (names.has(m.name.trim())) {
        setErr(`模型名称重复: ${m.name.trim()}`);
        return;
      }
      names.add(m.name.trim());
    }
    setErr("");
    setSaving(true);
    try {
      await saveHostConfig({
        models: models.map((m, i) => ({ ...m, name: m.name.trim(), default: i === defaultIdx })),
        mcp_servers: mcpsToServers(mcps),
      });
      // 成功后壳会重启内核并导航整页,这里保持"保存中"直到卸载
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", animation: "mcin .25s ease" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          padding: "40px 24px 60px",
        }}
      >
        <div style={{ width: 588, maxWidth: "100%", display: "flex", alignItems: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--t1)", letterSpacing: "-.01em" }}>设置</div>
          <div className="hv-cardh" onClick={onClose} style={{ ...btn, marginLeft: "auto" }}>
            返回
          </div>
        </div>

        {!desktop && (
          <div style={{ ...card, color: "var(--t4)", fontSize: 12.5, lineHeight: 1.7 }}>
            浏览器模式下配置只读:模型与 MCP 由启动 mc-agent 的宿主(桌面应用或环境变量)管理。
          </div>
        )}

        {desktop && !loaded && !err && (
          <div style={{ fontSize: 12.5, color: "var(--t5)" }}>读取配置中…</div>
        )}

        {desktop && loaded && (
          <>
            {/* ==== 模型 ==== */}
            <div style={{ width: 588, maxWidth: "100%", display: "flex", alignItems: "center", marginTop: 6 }}>
              <span style={{ font: "600 10.5px system-ui", color: "var(--t4)", letterSpacing: ".1em" }}>模型</span>
              <div
                className="hv-cardh"
                onClick={() => setModels((ms) => [...ms, emptyModel()])}
                style={{ ...btn, marginLeft: "auto", padding: "4px 10px" }}
              >
                + 添加模型
              </div>
            </div>
            {models.length === 0 && (
              <div style={{ ...card, color: "var(--t5)", fontSize: 12.5, borderStyle: "dashed" }}>
                还没有模型。保存后应用可运行,但需要添加模型才能开始任务。
              </div>
            )}
            {models.map((m, i) => (
              <div key={i} style={card}>
                <div style={{ display: "flex", gap: 10 }}>
                  <Field label="名称">
                    <input
                      style={input}
                      value={m.name}
                      placeholder="如: 主力模型"
                      onChange={(e) => patchModel(i, { name: e.target.value })}
                    />
                  </Field>
                  <Field label="协议">
                    <select
                      style={{ ...select, width: "100%" }}
                      value={m.provider || "anthropic"}
                      onChange={(e) => patchModel(i, { provider: e.target.value })}
                    >
                      <option value="anthropic">anthropic</option>
                      <option value="openai">openai(Chat Completions)</option>
                      <option value="openai_responses">openai_responses(Responses)</option>
                    </select>
                  </Field>
                </div>
                <div style={{ marginTop: 10 }}>
                  <Field label="接口地址">
                    <input
                      style={input}
                      value={m.base_url}
                      placeholder="https://api.example.com"
                      onChange={(e) => patchModel(i, { base_url: e.target.value })}
                    />
                  </Field>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <Field label="API Key">
                    <input
                      style={input}
                      type="password"
                      value={m.api_key}
                      placeholder="sk-..."
                      onChange={(e) => patchModel(i, { api_key: e.target.value })}
                    />
                  </Field>
                  <Field label="模型标识">
                    <input
                      style={input}
                      value={m.model}
                      placeholder="请求中的 model 字段"
                      onChange={(e) => patchModel(i, { model: e.target.value })}
                    />
                  </Field>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, fontSize: 12 }}>
                  {i === defaultIdx ? (
                    <span style={{ color: "var(--amberT)", fontWeight: 600 }}>✓ 默认模型</span>
                  ) : (
                    <span className="hv-t1" style={{ color: "var(--t4)", cursor: "pointer" }} onClick={() => setDefaultIdx(i)}>
                      设为默认
                    </span>
                  )}
                  <span
                    className="hv-err"
                    style={{ marginLeft: "auto", color: "var(--t4)", cursor: "pointer" }}
                    onClick={() => {
                      setModels((ms) => ms.filter((_, j) => j !== i));
                      setDefaultIdx((d) => (i < d ? d - 1 : i === d ? 0 : d));
                    }}
                  >
                    删除
                  </span>
                </div>
              </div>
            ))}

            {/* ==== MCP 服务器 ==== */}
            <div style={{ width: 588, maxWidth: "100%", display: "flex", alignItems: "center", marginTop: 16 }}>
              <span style={{ font: "600 10.5px system-ui", color: "var(--t4)", letterSpacing: ".1em" }}>MCP 服务器</span>
              <div
                className="hv-cardh"
                onClick={() => setMcps((ms) => [...ms, emptyMcp()])}
                style={{ ...btn, marginLeft: "auto", padding: "4px 10px" }}
              >
                + 添加 MCP
              </div>
            </div>
            {mcps.length === 0 && (
              <div style={{ ...card, color: "var(--t5)", fontSize: 12.5, borderStyle: "dashed" }}>
                未配置 MCP 服务器(可选)。项目级 .mc-agent/mcp.json 仍随仓库生效。
              </div>
            )}
            {mcps.map((m, i) => (
              <div key={i} style={card}>
                <div style={{ display: "flex", gap: 10 }}>
                  <Field label="名称">
                    <input
                      style={input}
                      value={m.name}
                      placeholder="如: context7"
                      onChange={(e) => patchMcp(i, { name: e.target.value })}
                    />
                  </Field>
                  <Field label="类型">
                    <select
                      style={{ ...select, width: "100%" }}
                      value={m.type}
                      onChange={(e) => patchMcp(i, { type: e.target.value as McpEntry["type"] })}
                    >
                      <option value="http">HTTP(URL)</option>
                      <option value="stdio">stdio(本地命令)</option>
                    </select>
                  </Field>
                </div>
                {m.type === "http" ? (
                  <div style={{ marginTop: 10 }}>
                    <Field label="URL">
                      <input
                        style={input}
                        value={m.url}
                        placeholder="https://mcp.example.com/mcp"
                        onChange={(e) => patchMcp(i, { url: e.target.value })}
                      />
                    </Field>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                    <Field label="命令">
                      <input
                        style={input}
                        value={m.command}
                        placeholder="npx"
                        onChange={(e) => patchMcp(i, { command: e.target.value })}
                      />
                    </Field>
                    <Field label="参数(空格分隔)">
                      <input
                        style={input}
                        value={m.args}
                        placeholder="@playwright/mcp"
                        onChange={(e) => patchMcp(i, { args: e.target.value })}
                      />
                    </Field>
                  </div>
                )}
                <div style={{ marginTop: 10 }}>
                  <Field label={m.type === "http" ? "Headers(每行 KEY=VALUE)" : "环境变量(每行 KEY=VALUE)"}>
                    <textarea
                      style={{ ...input, resize: "vertical" }}
                      rows={2}
                      value={m.kv}
                      onChange={(e) => patchMcp(i, { kv: e.target.value })}
                    />
                  </Field>
                </div>
                <div style={{ display: "flex", marginTop: 12, fontSize: 12 }}>
                  <span
                    className="hv-err"
                    style={{ marginLeft: "auto", color: "var(--t4)", cursor: "pointer" }}
                    onClick={() => setMcps((ms) => ms.filter((_, j) => j !== i))}
                  >
                    删除
                  </span>
                </div>
              </div>
            ))}

            {/* ==== 保存 ==== */}
            <div style={{ width: 588, maxWidth: "100%", display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
              <div
                className="hv-op"
                onClick={() => !saving && void save()}
                style={{
                  padding: "9px 22px",
                  borderRadius: 9,
                  background: "var(--amber)",
                  color: "var(--onAmber)",
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: "pointer",
                  opacity: saving ? 0.5 : 1,
                  userSelect: "none",
                }}
              >
                {saving ? "保存并重启内核中…" : "保存"}
              </div>
              <span style={{ fontSize: 12, color: "var(--t5)" }}>保存后内核自动重启,会话在磁盘不丢失。</span>
            </div>
          </>
        )}

        {err && (
          <div style={{ width: 588, maxWidth: "100%", fontSize: 12.5, color: "var(--err)" }}>{err}</div>
        )}
      </div>
    </div>
  );
}
