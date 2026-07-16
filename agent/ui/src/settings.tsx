// 设置视图:外观 / 关于(版本+检查更新) / 模型清单 / MCP 服务器。
// 配置所有权在壳(写盘 0600/env 注入/重启内核),本视图只负责渲染与编辑,
// 经 Tauri IPC get_config/save_config 读写;保存成功后壳会重启内核并把
// 整个页面导航到新内核 URL(本组件随之卸载)。
// 布局与数值取自设计稿 Settings 屏;MCP 段设计稿未画,按模型卡同风格排布。
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  getHostConfig,
  inDesktopShell,
  saveHostConfig,
  updateCheck,
  updateInstall,
  type UpdateStatus,
} from "./client";
import { MONO } from "./components";
import { IconBack, IconPlus } from "./icons";
import logoUrl from "./logo.png";
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

// ---- 样式原语(设计稿 Settings 的卡片/输入/按钮) ----

const card: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--cardBd)",
  borderRadius: 11,
  padding: 16,
  boxShadow: "var(--cardSh)",
};
const sectionLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  color: "var(--t4)",
};
const input: CSSProperties = {
  width: "100%",
  height: 30,
  border: "1px solid rgba(30,40,35,.13)",
  borderRadius: 7,
  background: "#fdfdfc",
  color: "var(--t1)",
  padding: "0 10px",
  fontSize: 12,
  fontFamily: MONO,
  outline: "none",
  minWidth: 0,
};
const select: CSSProperties = {
  width: "100%",
  height: 30,
  border: "1px solid rgba(30,40,35,.13)",
  borderRadius: 7,
  background: "#fdfdfc",
  color: "var(--t1)",
  padding: "0 6px",
  fontSize: 12,
  outline: "none",
  cursor: "pointer",
};
const whiteBtn: CSSProperties = {
  height: 28,
  border: "1px solid rgba(30,40,35,.15)",
  background: "var(--card)",
  color: "var(--t1)",
  borderRadius: 8,
  padding: "0 13px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 5,
  boxShadow: "var(--cardSh)",
  whiteSpace: "nowrap",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
      <span style={{ fontSize: 11.5, color: "var(--t3)", fontWeight: 600 }}>{label}</span>
      {children}
    </div>
  );
}

function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span style={sectionLabel}>{label}</span>
        <span style={{ flex: 1 }} />
        {action}
      </div>
      {children}
    </div>
  );
}

// ---- 关于卡(版本 + 检查更新;仅桌面壳) ----

function AboutCard({
  version,
  update,
  onUpdateStatus,
}: {
  version: string;
  update: UpdateStatus | null;
  onUpdateStatus: (s: UpdateStatus) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "checking" | "installing">("idle");
  const [msg, setMsg] = useState<{ text: string; color: string } | null>(null);
  const found = !!update?.available;

  const check = async () => {
    setPhase("checking");
    setMsg(null);
    try {
      const s = await updateCheck();
      onUpdateStatus(s);
      if (!s.available) setMsg({ text: "已是最新版本", color: "var(--ok)" });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), color: "var(--err)" });
    } finally {
      setPhase("idle");
    }
  };

  const install = async () => {
    setPhase("installing");
    setMsg(null);
    try {
      await updateInstall(); // 成功即安装并重启,不会返回
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), color: "var(--err)" });
      setPhase("idle");
    }
  };

  const busy = phase !== "idle";
  const label = phase === "checking" ? "检查中" : phase === "installing" ? "更新中" : found ? "下载更新" : "检查更新";
  const green = found && phase !== "checking";

  return (
    <div style={{ ...card, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, background: "var(--accBg)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
        <img src={logoUrl} alt="" draggable={false} style={{ width: 22, height: 22, borderRadius: 5 }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>MonkeyCode</span>
        <span style={{ fontSize: 11.5, color: "var(--t5)", fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {found ? `${update?.current ?? version} → ${update?.latest} 可用` : version}
        </span>
      </div>
      <span style={{ flex: 1 }} />
      {msg && <span style={{ fontSize: 12, color: msg.color, flex: "none" }}>{msg.text}</span>}
      <button
        className={green ? "hv-acc" : "hv"}
        onClick={() => !busy && void (green ? install() : check())}
        style={{
          ...whiteBtn,
          gap: 6,
          flex: "none",
          ...(green ? { background: "var(--acc)", borderColor: "var(--acc)", color: "var(--onAcc)" } : {}),
          opacity: busy ? 0.7 : 1,
          cursor: busy ? "default" : "pointer",
        }}
      >
        {busy && (
          <span
            style={{
              width: 11,
              height: 11,
              border: `1.5px solid ${green ? "var(--onAcc)" : "var(--t1)"}`,
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "mcspin .9s linear infinite",
              display: "inline-block",
            }}
          />
        )}
        {label}
      </button>
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

export function SettingsView({
  onClose,
  hostVersion,
  update,
  onUpdateStatus,
}: {
  onClose: () => void;
  hostVersion: string | null;
  update: UpdateStatus | null;
  onUpdateStatus: (s: UpdateStatus) => void;
}) {
  const desktop = inDesktopShell();
  const [models, setModels] = useState<HostModel[]>([]);
  const [defaultIdx, setDefaultIdx] = useState(0);
  const [advOpen, setAdvOpen] = useState<Record<number, boolean>>({});
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

  const addBtn = (label: string, onClick: () => void) => (
    <button
      className="hv-accbg"
      onClick={onClick}
      style={{
        height: 26,
        border: "1px solid rgba(31,138,91,.3)",
        background: "transparent",
        color: "var(--acc)",
        borderRadius: 8,
        padding: "0 11px",
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 5,
      }}
    >
      <IconPlus size={10} color="var(--acc)" />
      {label}
    </button>
  );

  return (
    <div style={{ flex: 1, overflowY: "auto", minHeight: 0, animation: "mcin .25s ease" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "28px 36px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <span style={{ fontSize: 20, fontWeight: 800 }}>设置</span>
          <span style={{ flex: 1 }} />
          <button className="hv" onClick={onClose} style={whiteBtn}>
            <IconBack />
            返回
          </button>
        </div>

        {/* ==== 外观 ==== */}
        <Section label="外观">
          <div style={{ ...card, padding: "14px 16px", display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ display: "flex", background: "rgba(120,130,125,.13)", borderRadius: 8, padding: 3, gap: 2 }}>
              <button
                style={{
                  border: "none",
                  borderRadius: 6,
                  height: 26,
                  padding: "0 15px",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  background: "var(--card)",
                  color: "var(--t1)",
                  boxShadow: "0 1px 3px rgba(0,0,0,.12)",
                }}
              >
                浅色
              </button>
              <button
                title="深色模式即将支持"
                style={{
                  border: "none",
                  borderRadius: 6,
                  height: 26,
                  padding: "0 15px",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "not-allowed",
                  background: "transparent",
                  color: "#b3b9b2",
                }}
              >
                深色
              </button>
            </div>
            <span style={{ fontSize: 12, color: "var(--t5)" }}>深色模式即将支持。</span>
          </div>
        </Section>

        {/* ==== 关于(仅桌面壳:版本与更新由壳持有)==== */}
        {desktop && (
          <Section label="关于">
            <AboutCard version={hostVersion ?? "—"} update={update} onUpdateStatus={onUpdateStatus} />
          </Section>
        )}

        {!desktop && (
          <div style={{ ...card, color: "var(--t4)", fontSize: 12.5, lineHeight: 1.7 }}>
            浏览器模式下配置只读:模型与 MCP 由启动 mc-agent 的宿主(桌面应用或环境变量)管理。
          </div>
        )}

        {desktop && !loaded && !err && <div style={{ fontSize: 12.5, color: "var(--t5)" }}>读取配置中…</div>}

        {desktop && loaded && (
          <>
            {/* ==== 模型 ==== */}
            <Section label="模型" action={addBtn("添加模型", () => setModels((ms) => [...ms, emptyModel()]))}>
              {models.length === 0 && (
                <div style={{ ...card, color: "var(--t5)", fontSize: 12.5, borderStyle: "dashed" }}>
                  还没有模型。保存后应用可运行,但需要添加模型才能开始任务。
                </div>
              )}
              {models.map((m, i) => (
                <div key={i} style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 240px", gap: 12 }}>
                    <Field label="名称">
                      <input style={input} value={m.name} placeholder="如: 主力模型" onChange={(e) => patchModel(i, { name: e.target.value })} className="hv-bd" />
                    </Field>
                    <Field label="协议">
                      <select style={select} value={m.provider || "anthropic"} onChange={(e) => patchModel(i, { provider: e.target.value })}>
                        <option value="anthropic">anthropic</option>
                        <option value="openai">openai(Chat Completions)</option>
                        <option value="openai_responses">openai_responses(Responses)</option>
                      </select>
                    </Field>
                  </div>
                  <Field label="接口地址">
                    <input style={input} value={m.base_url} placeholder="https://api.example.com" onChange={(e) => patchModel(i, { base_url: e.target.value })} className="hv-bd" />
                  </Field>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Field label="API Key">
                      <input style={input} type="password" value={m.api_key} placeholder="sk-..." onChange={(e) => patchModel(i, { api_key: e.target.value })} className="hv-bd" />
                    </Field>
                    <Field label="模型标识">
                      <input style={input} value={m.model} placeholder="请求中的 model 字段" onChange={(e) => patchModel(i, { model: e.target.value })} className="hv-bd" />
                    </Field>
                  </div>
                  {advOpen[i] && (
                    <>
                      <Field label="上下文窗口(token)">
                        <input
                          style={input}
                          type="number"
                          min={1}
                          value={m.context_window ?? ""}
                          placeholder="200000(默认)"
                          onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            patchModel(i, { context_window: Number.isFinite(n) && n > 0 ? n : undefined });
                          }}
                          className="hv-bd"
                        />
                      </Field>
                      <label
                        title="跳过 HTTPS 证书校验,连接可被窃听或篡改。仅用于自签名证书的内网网关;公网接口在老系统(如 Win7)验不过时内核会自动用内置根证书兜底,无需开启"
                        style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--t3)", cursor: "pointer", fontSize: 12, userSelect: "none" }}
                      >
                        <input
                          type="checkbox"
                          checked={!!m.skip_tls_verify}
                          onChange={(e) => patchModel(i, { skip_tls_verify: e.target.checked || undefined })}
                          style={{ accentColor: "var(--err)", margin: 0 }}
                        />
                        跳过 TLS 证书校验
                        {m.skip_tls_verify && <span style={{ color: "var(--err)", fontWeight: 600 }}>(不安全,仅限内网自签名网关)</span>}
                      </label>
                    </>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 14, paddingTop: 2, fontSize: 12 }}>
                    <span
                      className="hv-t1"
                      onClick={() => setAdvOpen((o) => ({ ...o, [i]: !o[i] }))}
                      style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--t5)", cursor: "pointer", userSelect: "none" }}
                    >
                      <span style={{ display: "inline-block", transform: advOpen[i] ? "rotate(90deg)" : "none", transition: "transform .15s ease", fontSize: 9 }}>▸</span>
                      高级选项
                      {!advOpen[i] && m.context_window ? `(上下文窗口 ${m.context_window.toLocaleString()})` : ""}
                    </span>
                    <label
                      title="模型支持图片输入(视觉)。未勾选时对话里的图片以文件路径提供,模型不会收到图片内容"
                      style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--t3)", cursor: "pointer", fontWeight: 600, userSelect: "none" }}
                    >
                      <input
                        type="checkbox"
                        checked={!!m.vision}
                        onChange={(e) => patchModel(i, { vision: e.target.checked })}
                        style={{ accentColor: "var(--acc)", margin: 0 }}
                      />
                      支持图片
                    </label>
                    {i === defaultIdx ? (
                      <span style={{ display: "flex", alignItems: "center", gap: 5, fontWeight: 700, color: "var(--acc)" }}>✓ 默认模型</span>
                    ) : (
                      <span className="hv-t1" onClick={() => setDefaultIdx(i)} style={{ color: "var(--t3)", cursor: "pointer", fontWeight: 600 }}>
                        设为默认
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    <span
                      className="hv-err"
                      style={{ color: "var(--t5)", cursor: "pointer" }}
                      onClick={() => {
                        setModels((ms) => ms.filter((_, j) => j !== i));
                        setDefaultIdx((d) => (i < d ? d - 1 : i === d ? 0 : d));
                        setAdvOpen({}); // 按索引记忆,删除后索引移位,全部复位折叠
                      }}
                    >
                      删除
                    </span>
                  </div>
                </div>
              ))}
            </Section>

            {/* ==== MCP 服务器 ==== */}
            <Section label="MCP 服务器" action={addBtn("添加 MCP", () => setMcps((ms) => [...ms, emptyMcp()]))}>
              {mcps.length === 0 && (
                <div style={{ ...card, color: "var(--t5)", fontSize: 12.5, borderStyle: "dashed" }}>
                  未配置 MCP 服务器(可选)。项目级 .mc-agent/mcp.json 仍随仓库生效。
                </div>
              )}
              {mcps.map((m, i) => (
                <div key={i} style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 240px", gap: 12 }}>
                    <Field label="名称">
                      <input style={input} value={m.name} placeholder="如: context7" onChange={(e) => patchMcp(i, { name: e.target.value })} className="hv-bd" />
                    </Field>
                    <Field label="类型">
                      <select style={select} value={m.type} onChange={(e) => patchMcp(i, { type: e.target.value as McpEntry["type"] })}>
                        <option value="http">HTTP(URL)</option>
                        <option value="stdio">stdio(本地命令)</option>
                      </select>
                    </Field>
                  </div>
                  {m.type === "http" ? (
                    <Field label="URL">
                      <input style={input} value={m.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => patchMcp(i, { url: e.target.value })} className="hv-bd" />
                    </Field>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Field label="命令">
                        <input style={input} value={m.command} placeholder="npx" onChange={(e) => patchMcp(i, { command: e.target.value })} className="hv-bd" />
                      </Field>
                      <Field label="参数(空格分隔)">
                        <input style={input} value={m.args} placeholder="@playwright/mcp" onChange={(e) => patchMcp(i, { args: e.target.value })} className="hv-bd" />
                      </Field>
                    </div>
                  )}
                  <Field label={m.type === "http" ? "Headers(每行 KEY=VALUE)" : "环境变量(每行 KEY=VALUE)"}>
                    <textarea
                      style={{ ...input, height: "auto", padding: "7px 10px", resize: "vertical", lineHeight: 1.6 }}
                      rows={2}
                      value={m.kv}
                      onChange={(e) => patchMcp(i, { kv: e.target.value })}
                      className="hv-bd"
                    />
                  </Field>
                  <div style={{ display: "flex", fontSize: 12 }}>
                    <span className="hv-err" style={{ marginLeft: "auto", color: "var(--t5)", cursor: "pointer" }} onClick={() => setMcps((ms) => ms.filter((_, j) => j !== i))}>
                      删除
                    </span>
                  </div>
                </div>
              ))}
            </Section>

            {/* ==== 保存 ==== */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                className="hv-acc"
                onClick={() => !saving && void save()}
                style={{
                  height: 32,
                  border: "none",
                  borderRadius: 9,
                  background: "var(--acc)",
                  color: "var(--onAcc)",
                  fontWeight: 700,
                  fontSize: 13,
                  padding: "0 22px",
                  cursor: "pointer",
                  opacity: saving ? 0.6 : 1,
                  boxShadow: "0 2px 8px rgba(31,138,91,.25)",
                }}
              >
                {saving ? "保存并重启内核中…" : "保存"}
              </button>
              <span style={{ fontSize: 12, color: "var(--t5)" }}>保存后内核自动重启,会话在磁盘不丢失。</span>
            </div>
          </>
        )}

        {err && <div style={{ fontSize: 12.5, color: "var(--err)" }}>{err}</div>}
      </div>
    </div>
  );
}
