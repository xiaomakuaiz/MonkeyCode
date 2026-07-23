// 设置视图:左侧分类导航(百智云账号 / 模型 / MCP / 通用)+ 右侧单分类内容
// + 底部脏状态保存条。账号优先:MonkeyCode 是百智云旗下产品,"登录 → 同步"
// 是主路径,手工配置是高级路径。
// 配置所有权在壳(写盘 0600/env 注入/重启内核),本视图只负责渲染与编辑,
// 经 Tauri IPC get_config/save_config 读写;保存成功后壳会重启内核并把
// 整个页面导航到新内核 URL(本组件随之卸载)。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { BaizhiCard } from "./baizhi";
import { baizhiStatus } from "./baizhiapi";
import {
  getBrowserExtStatus,
  getHostConfig,
  inDesktopShell,
  isWindowsShell,
  listWslDistros,
  openExtensionDir,
  repairBrowserExt,
  saveHostConfig,
  updateCheck,
  updateInstall,
} from "./host";
import { engineCaps } from "./session";
import { MONO } from "./components";
import { IconBack, IconCloud, IconGear, IconGlobe, IconMonitor, IconPlus, IconSpark } from "./icons";
import { BaizhiLogo } from "./baizhi";
import logoUrl from "./logo.png";
import { Field, Section, input, select, whiteBtn } from "./settings-ui";
import { MacDragSpacer } from "./titlebar";
import {
  SOURCE_BAIZHI,
  modelSourceLabel,
  type BaizhiStatus,
  type BaizhiSyncResult,
  type BrowserExtStatus,
  type EngineCaps,
  type HostConfig,
  type HostModel,
  type McConnectionState,
  type UpdateStatus,
} from "./types";

// ---- MCP 编辑模型与序列化(与内核 mcp.json 的 mcpServers 同构,壳不解释) ----

interface McpEntry {
  name: string;
  type: "http" | "stdio";
  url: string;
  command: string;
  args: string; // 空格分隔
  kv: string; // 每行 KEY=VALUE;http→headers,stdio→env
  source?: string; // "baizhi"=百智云同步;缺省=手工。随 mcp.json 落盘(内核忽略)
  /** 表单未呈现的其余字段(如 disabled):原样携带,保存时透传回 mcp.json 不丢失 */
  extra?: Record<string, unknown>;
}

/** serversToMcps 拆进表单字段的键;其余键进 extra 原样往返 */
const MCP_FORM_KEYS = new Set(["url", "command", "args", "env", "headers", "source"]);

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
    // extra 先铺底(disabled 等表单外字段透传),表单字段覆盖;
    // source 随条目落盘(内核 mcp.json 解析忽略;omitempty 语义,手工条目不带)
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

function serversToMcps(servers: Record<string, unknown>): McpEntry[] {
  return Object.entries(servers).map(([name, c]) => {
    const cfg = (c ?? {}) as Record<string, unknown>;
    const stdio = typeof cfg.command === "string" && cfg.command !== "";
    const extra = Object.fromEntries(Object.entries(cfg).filter(([k]) => !MCP_FORM_KEYS.has(k)));
    return {
      name,
      type: stdio ? "stdio" : "http",
      url: typeof cfg.url === "string" ? cfg.url : "",
      command: typeof cfg.command === "string" ? cfg.command : "",
      args: Array.isArray(cfg.args) ? cfg.args.map(String).join(" ") : "",
      kv: stringifyKV(stdio ? cfg.env : cfg.headers),
      source: typeof cfg.source === "string" ? cfg.source : undefined,
      extra: Object.keys(extra).length ? extra : undefined,
    };
  });
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
    <div className="card card-lg" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, background: "var(--accBg)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
        <img src={logoUrl} alt="" draggable={false} style={{ width: 22, height: 22, borderRadius: 5 }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>MonkeyCode</span>
        <span className="ellipsis" style={{ fontSize: 11.5, color: "var(--t5)", fontFamily: MONO }}>
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

// ---- 浏览器扩展卡(扩展桥状态/配对;内核 HTTP 状态端点,桌面与浏览器模式通用) ----

function BrowserExtCard() {
  const [st, setSt] = useState<BrowserExtStatus | null>(null);
  const [fetchErr, setFetchErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [extDirMsg, setExtDirMsg] = useState("");

  const refresh = async () => {
    try {
      setSt(await getBrowserExtStatus());
      setFetchErr("");
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : String(e));
    }
  };
  // 挂载即拉取 + 5s 轮询(仅本分类页挂载期间;配对/连接状态变化靠它反映)
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, []);

  const repair = async () => {
    setBusy(true);
    try {
      setSt(await repairBrowserExt());
      setFetchErr("");
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const code = st?.pairing_code ?? "";
  const codeShown = code ? `${code.slice(0, 4)}-${code.slice(4)}` : "";
  const copyCode = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const dot = (color: string) => (
    <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flex: "none", display: "inline-block" }} />
  );

  let statusLine: JSX.Element;
  if (fetchErr) {
    statusLine = <>{dot("var(--err)")}<span>状态读取失败: {fetchErr}</span></>;
  } else if (!st) {
    statusLine = <>{dot("var(--t5)")}<span>读取状态中…</span></>;
  } else if (!st.enabled) {
    statusLine = <>{dot("var(--err)")}<span>扩展桥未启用{st.error ? `: ${st.error}` : ""}</span></>;
  } else if (st.connected) {
    statusLine = (
      <>
        {dot("var(--ok)")}
        <span>
          已连接 · {st.browser_name || "浏览器"}
          {st.browser_version ? ` ${st.browser_version}` : ""}
        </span>
      </>
    );
  } else if (st.paired) {
    statusLine = <>{dot("var(--warn)")}<span>已配对,等待扩展连接(浏览器未开或扩展未启用)</span></>;
  } else {
    statusLine = <>{dot("var(--warn)")}<span>未配对</span></>;
  }

  return (
    <>
      <div className="card card-lg" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--t2)", fontWeight: 600 }}>
          {statusLine}
          <span style={{ flex: 1 }} />
          {st?.enabled && st.paired && (
            <button className="hv" onClick={() => !busy && void repair()} style={{ ...whiteBtn, flex: "none", opacity: busy ? 0.7 : 1 }}>
              重新配对
            </button>
          )}
        </div>
        {st?.enabled && !st.paired && code && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 12, color: "var(--t4)", flex: "none" }}>配对码</span>
            <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, letterSpacing: 2, color: "var(--t1)" }}>{codeShown}</span>
            <button className="hv" onClick={copyCode} style={{ ...whiteBtn, height: 24, padding: "0 9px", fontSize: 11.5, flex: "none" }}>
              {copied ? "已复制" : "复制"}
            </button>
          </div>
        )}
        {st?.enabled && st.addr && (
          <span style={{ fontSize: 11.5, color: "var(--t5)", fontFamily: MONO }}>桥接地址: {st.addr}</span>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--t4)", lineHeight: 1.8 }}>
        安装 MonkeyCode 浏览器扩展后,agent 可以在你的浏览器里打开网页、点击、输入、截图(共享登录态,操作前会请求授权):
        <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          <li>
            {inDesktopShell() ? (
              <>
                点击
                <button
                  className="hv"
                  onClick={() => {
                    void openExtensionDir()
                      .then((p) => setExtDirMsg(p ? `已在文件管理器中定位: ${p}` : ""))
                      .catch((e) => setExtDirMsg(e instanceof Error ? e.message : String(e)));
                  }}
                  style={{ ...whiteBtn, height: 22, padding: "0 8px", fontSize: 11.5, margin: "0 4px", verticalAlign: "middle" }}
                >
                  打开扩展目录
                </button>
                → 在 Chrome/Edge 扩展管理页(chrome://extensions)开启「开发者模式」→「加载已解压的扩展程序」选择该目录;
              </>
            ) : (
              <>在 Chrome/Edge 打开扩展管理页(chrome://extensions),开启「开发者模式」,「加载已解压的扩展程序」选择仓库的 browser-extension/dist 目录(构建见其 README);</>
            )}
          </li>
          <li>点击扩展图标 → 选项,填入上方配对码完成配对;</li>
          <li>状态变为「已连接」即可在对话中使用;操作标签页顶部会显示浏览器自带的调试提示条,点击其「取消」即收回控制。</li>
        </ol>
        {extDirMsg && <div style={{ fontSize: 11.5, color: "var(--t5)", fontFamily: MONO, marginTop: 4 }}>{extDirMsg}</div>}
        操作你已打开的页面:点扩展图标 →「把此标签页交给 agent 操作」。
      </div>
    </>
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

/** 百智云组整组替换(模型与 MCP 共用语义):手工条目(无 source)原样保留,
 * 百智云组替换为本次同步集合——取消勾选的旧同步条目随之移除(重同步清理)。
 * keepManualOnCollision:同名手工条目是否保留——MCP 导入是全有全无的单个勾选,
 * 用户无法逐条排除,不能静默吞掉手工配置(一旦被覆盖归组,下次重同步会连带删除);
 * 模型导入经逐条勾选确认,同名手工条目按用户选择被同步值覆盖并归组。 */
function replaceBaizhiGroup<T extends { name: string; source?: string }>(
  cur: T[],
  synced: T[],
  keepManualOnCollision: boolean,
): T[] {
  const kept = cur.filter((m) => m.name.trim() && m.source !== SOURCE_BAIZHI);
  const byName = new Map(kept.map((m) => [m.name.trim(), m]));
  const manualNames = new Set(byName.keys());
  for (const e of synced) {
    const name = e.name.trim();
    if (keepManualOnCollision && manualNames.has(name)) continue;
    byName.set(name, e);
  }
  return [...byName.values()];
}

// ---- 分类导航 ----

type SectionKey = "account" | "models" | "mcp" | "browser" | "general";

const NAV: { key: SectionKey; label: string; icon: (p: { size?: number; color?: string }) => JSX.Element }[] = [
  { key: "account", label: "账号与云端", icon: BaizhiLogo },
  { key: "models", label: "模型", icon: IconSpark },
  { key: "mcp", label: "MCP 服务器", icon: IconMonitor },
  { key: "browser", label: "浏览器", icon: IconGlobe },
  { key: "general", label: "通用", icon: IconGear },
];

// 徽标小药丸(provider/类型/来源)
const pill: CSSProperties = {
  flex: "none",
  fontSize: 10.5,
  fontWeight: 600,
  padding: "1px 7px",
  borderRadius: 5,
  background: "var(--hov)",
  color: "var(--t4)",
  whiteSpace: "nowrap",
};

// 空态虚线卡
const emptyCard: CSSProperties = {
  color: "var(--t5)",
  fontSize: 12.5,
  border: "1px dashed var(--dashBd)",
  borderRadius: 10,
  padding: 16,
  lineHeight: 1.7,
};

function mcIdentity(s: McConnectionState): string {
  const u = s.user;
  return u?.name || u?.username || u?.email || u?.id || "MonkeyCode 用户";
}

/** MonkeyCode 云端任务关联卡。百智云只是显式连接时的授权前提,
 * 两者状态和退出操作互不代替。 */
function MonkeyCodeAccountCard({
  connection,
  baizhiLoggedIn,
  onConnect,
  onRetry,
  onDisconnect,
}: {
  connection: McConnectionState;
  baizhiLoggedIn: boolean;
  onConnect: () => void;
  onRetry: () => void;
  onDisconnect: () => void;
}) {
  const busy = connection.phase === "checking" || connection.phase === "connecting" || connection.phase === "disconnecting";
  const connected = connection.phase === "connected";
  const status =
    connection.phase === "checking"
      ? "检查中"
      : connection.phase === "connecting"
        ? "连接中"
        : connection.phase === "disconnecting"
          ? "断开中"
          : connected
            ? "已关联"
            : connection.phase === "error"
              ? "状态异常"
              : "未关联";
  const message = (() => {
    if (connection.error) return connection.error;
    if (connection.phase === "checking") return "正在读取 MonkeyCode 关联状态…";
    if (connection.phase === "connecting") return "正在使用百智云账号完成授权…";
    if (connection.phase === "disconnecting") return "正在清除本机 MonkeyCode 会话…";
    if (connected) return `已关联为 ${mcIdentity(connection)}，远端任务会显示在主界面侧栏。`;
    if (!baizhiLoggedIn) return "请先登录上方百智云账号，再连接 MonkeyCode。";
    return "连接后可查看、创建并实时跟看 MonkeyCode 远端任务。";
  })();
  const canConnect = baizhiLoggedIn && !busy;

  return (
    <div className="card card-lg" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: "var(--accBg)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
          <IconCloud size={16} color="var(--acc)" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>MonkeyCode 云端任务</span>
          <span className="ellipsis" style={{ fontSize: 11.5, color: "var(--t5)", fontFamily: MONO }}>{connection.host}</span>
        </div>
        <span style={{ flex: 1 }} />
        <span
          style={{
            flex: "none",
            padding: "2px 7px",
            borderRadius: 6,
            fontSize: 10.5,
            fontWeight: 700,
            color: connected ? "var(--ok)" : connection.phase === "error" ? "var(--err)" : "var(--t4)",
            background: connected ? "var(--accBg)" : "var(--hov)",
          }}
        >
          {status}
        </span>
        {connected || connection.phase === "disconnecting" ? (
          <button className="hv" disabled={busy} onClick={onDisconnect} style={{ ...whiteBtn, flex: "none", opacity: busy ? 0.6 : 1 }}>
            {connection.phase === "disconnecting" ? "断开中…" : "断开关联"}
          </button>
        ) : connection.phase === "error" ? (
          <button className="hv" disabled={busy} onClick={onRetry} style={{ ...whiteBtn, flex: "none", opacity: busy ? 0.6 : 1 }}>
            重试状态
          </button>
        ) : (
          <button
            className="hv-acc"
            disabled={!canConnect}
            onClick={onConnect}
            style={{
              ...whiteBtn,
              flex: "none",
              background: "var(--acc)",
              borderColor: "var(--acc)",
              color: "var(--onAcc)",
              opacity: canConnect ? 1 : 0.55,
              cursor: canConnect ? "pointer" : "default",
            }}
          >
            {connection.phase === "connecting" ? "连接中…" : "连接 MonkeyCode"}
          </button>
        )}
      </div>
      <span style={{ fontSize: 11.5, color: connection.error ? "var(--err)" : "var(--t5)", lineHeight: 1.6 }}>{message}</span>
    </div>
  );
}

// ---- 设置视图 ----

export function SettingsView({
  onClose,
  hostVersion,
  update,
  onUpdateStatus,
  onDirtyChange,
  mcConnection,
  onConnectMc,
  onRetryMc,
  onDisconnectMc,
}: {
  onClose: () => void;
  hostVersion: string | null;
  update: UpdateStatus | null;
  onUpdateStatus: (s: UpdateStatus) => void;
  /** 脏状态上报(宿主据此在关闭前确认);卸载时自动报 false */
  onDirtyChange?: (dirty: boolean) => void;
  mcConnection: McConnectionState;
  onConnectMc: () => void;
  onRetryMc: () => void;
  onDisconnectMc: () => void;
}) {
  const desktop = inDesktopShell();
  const [active, setActive] = useState<SectionKey>("account");
  const [models, setModels] = useState<HostModel[]>([]);
  const [defaultIdx, setDefaultIdx] = useState(0);
  const [advOpen, setAdvOpen] = useState<Record<number, boolean>>({});
  const [expanded, setExpanded] = useState<number | null>(null); // 展开编辑的模型(真实索引)
  const [baizhiOpen, setBaizhiOpen] = useState(true); // 百智云组(账号优先,默认展开)
  const [mcps, setMcps] = useState<McpEntry[]>([]);
  const [mcpExpanded, setMcpExpanded] = useState<number | null>(null);
  const [baizhiMcpOpen, setBaizhiMcpOpen] = useState(true); // 百智云 MCP 组(默认展开)
  const [kernelEnv, setKernelEnv] = useState(""); // 内核运行环境:"" 本机 / "wsl:<发行版>"
  const [caps, setCaps] = useState<EngineCaps | null>(null); // 当前引擎能力(浏览器 tab 按此隐藏)
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  // 登录态由 Shell 持有:账号页 BaizhiCard 与模型/MCP 页的引导条共用
  const [bzStatus, setBzStatus] = useState<BaizhiStatus | null>(null);
  const [bzErr, setBzErr] = useState("");
  const refreshBz = async () => {
    try {
      const s = await baizhiStatus();
      setBzStatus(s);
      setBzErr("");
    } catch (e) {
      setBzErr(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void refreshBz();
  }, []);
  const loggedIn = !!bzStatus?.logged_in;

  // 归一化保存载荷:save() 与 dirty 比较共用同一形态(名称 trim、default 重算、MCP 序列化)
  const payloadOf = (ms: HostModel[], di: number, mc: McpEntry[], ke: string): HostConfig => ({
    models: ms.map((m, i) => ({ ...m, name: m.name.trim(), default: i === di })),
    mcp_servers: mcpsToServers(mc),
    kernel_env: ke,
  });

  // 加载快照:baseline 供 dirty 比较,snapshot 供「放弃更改」复原
  const baseline = useRef("");
  const snapshot = useRef<{ models: HostModel[]; defaultIdx: number; mcps: McpEntry[]; kernelEnv: string } | null>(null);

  useEffect(() => {
    if (!desktop) {
      setLoaded(true);
      return;
    }
    getHostConfig()
      .then((cfg) => {
        const ms = cfg?.models ?? [];
        const di = Math.max(0, ms.findIndex((m) => m.default));
        const mc = serversToMcps(cfg?.mcp_servers ?? {});
        const ke = cfg?.kernel_env ?? "";
        setModels(ms);
        setDefaultIdx(di);
        setMcps(mc);
        setKernelEnv(ke);
        snapshot.current = { models: ms, defaultIdx: di, mcps: mc, kernelEnv: ke };
        baseline.current = JSON.stringify(payloadOf(ms, di, mc, ke));
        setLoaded(true);
      })
      .catch((e) => setErr("读取配置失败: " + (e instanceof Error ? e.message : String(e))));
    if (isWindowsShell()) {
      void listWslDistros().then(setWslDistros);
    }
    void engineCaps().then(setCaps).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop]);

  const dirty = useMemo(
    () => desktop && loaded && JSON.stringify(payloadOf(models, defaultIdx, mcps, kernelEnv)) !== baseline.current,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [desktop, loaded, models, defaultIdx, mcps, kernelEnv],
  );
  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);
  useEffect(
    () => () => onDirtyChange?.(false), // 卸载即不再脏(宿主复位关闭守卫)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const discard = () => {
    const s = snapshot.current;
    if (!s) return;
    setModels(s.models);
    setDefaultIdx(s.defaultIdx);
    setMcps(s.mcps);
    setKernelEnv(s.kernelEnv);
    setExpanded(null);
    setMcpExpanded(null);
    setAdvOpen({});
    setErr("");
  };

  const patchModel = (i: number, patch: Partial<HostModel>) =>
    setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const patchMcp = (i: number, patch: Partial<McpEntry>) =>
    setMcps((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  // 同步导入:整组替换语义见 replaceBaizhiGroup。导入即进脏态,保存条浮现;
  // 自动切到模型页供核对。
  const applySynced = (r: BaizhiSyncResult) => {
    // 只导入 MCP(勾选 0 个模型)时不触碰模型组:空选集不视为"清空百智云组"
    if (r.models.length) {
      const defaultName = models[defaultIdx]?.name?.trim() ?? "";
      const synced = r.models.map((sm) => ({
        name: sm.name,
        provider: sm.provider,
        base_url: sm.base_url,
        api_key: sm.api_key,
        model: sm.model,
        context_window: sm.context_window,
        vision: sm.vision,
        source: sm.source,
      }));
      const next = replaceBaizhiGroup(models, synced, false);
      setModels(next);
      // 索引大位移:默认模型按名字重新定位(被移除则回退第一项),折叠态复位
      const di = next.findIndex((m) => m.name.trim() === defaultName);
      setDefaultIdx(di >= 0 ? di : 0);
      setAdvOpen({});
      setExpanded(null);
      setBaizhiOpen(true);
    }
    // MCP:本次无条目(如网关未开通)则不触碰(空集不清组,对齐模型语义);
    // 同步条目已带 source=baizhi
    const syncedMcps = serversToMcps(r.mcp_servers);
    if (syncedMcps.length) {
      setMcps((cur) => replaceBaizhiGroup(cur, syncedMcps, true));
      setMcpExpanded(null);
    }
    setActive("models"); // 导入后直接看结果
  };

  const save = async () => {
    // UX 前置校验;权威校验在内核 LoadModels(重复名/provider 白名单等)
    for (const m of models) {
      if (!m.name.trim() || !m.base_url.trim() || !m.api_key.trim() || !m.model.trim()) {
        setErr(`模型「${m.name.trim() || "未命名"}」信息不完整(需名称/接口地址/API Key/模型标识)`);
        setActive("models");
        return;
      }
    }
    const names = new Set<string>();
    for (const m of models) {
      if (names.has(m.name.trim())) {
        setErr(`模型名称重复: ${m.name.trim()}`);
        setActive("models");
        return;
      }
      names.add(m.name.trim());
    }
    setErr("");
    setSaving(true);
    try {
      await saveHostConfig(payloadOf(models, defaultIdx, mcps, kernelEnv));
      // 壳已重启引擎:整页刷新复位所有状态并重连(保持"保存中"直到卸载)
      location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const addBtn = (label: string, onClick: () => void) => (
    <button className="hv" onClick={onClick} style={{ ...whiteBtn, height: 24, padding: "0 9px", fontSize: 11.5, gap: 4 }}>
      <IconPlus />
      {label}
    </button>
  );

  // ---- 模型:紧凑行 + 手风琴编辑(i 恒为 models 真实索引) ----

  const modelRow = (m: HostModel, i: number) => {
    const isOpen = expanded === i;
    return (
      <>
        <div
          className="hrow hv2"
          onClick={() => setExpanded(isOpen ? null : i)}
          style={{ display: "flex", alignItems: "center", gap: 8, height: 40, padding: "0 14px", cursor: "pointer", userSelect: "none" }}
        >
          <span className="ellipsis" style={{ fontSize: 12.5, fontFamily: MONO, color: m.name.trim() ? "var(--t1)" : "var(--t5)", minWidth: 0 }}>
            {m.name.trim() || "未命名模型"}
          </span>
          <span style={pill}>{m.provider || "anthropic"}</span>
          {m.vision && <span style={{ ...pill, background: "var(--accBg)", color: "var(--acc)" }}>视觉</span>}
          {i === defaultIdx && (
            <span style={{ flex: "none", fontSize: 11, fontWeight: 700, color: "var(--acc)", whiteSpace: "nowrap" }}>✓ 默认</span>
          )}
          <span style={{ flex: 1 }} />
          <span className="row-acts" style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, flex: "none" }}>
            {i !== defaultIdx && (
              <span
                className="hv-t1"
                style={{ color: "var(--t4)", fontWeight: 600 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setDefaultIdx(i);
                }}
              >
                设为默认
              </span>
            )}
            <span
              className="hv-err"
              style={{ color: "var(--t5)" }}
              onClick={(e) => {
                e.stopPropagation();
                setModels((ms) => ms.filter((_, j) => j !== i));
                setDefaultIdx((d) => (i < d ? d - 1 : i === d ? 0 : d));
                setAdvOpen({}); // 按索引记忆,删除后索引移位,全部复位
                setExpanded(null);
              }}
            >
              删除
            </span>
          </span>
          <span
            style={{ flex: "none", display: "inline-block", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s ease", fontSize: 9, color: "var(--t5)" }}
          >
            ▸
          </span>
        </div>
        {isOpen && modelForm(m, i)}
      </>
    );
  };

  const modelForm = (m: HostModel, i: number) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 14px 14px" }}>
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
      </div>
    </div>
  );

  /** 一组条目行装进一张卡(行间分隔线;j 为组内序,i 用真实索引);模型/MCP 共用 */
  const groupCard = <T,>(entries: { m: T; i: number }[], row: (m: T, i: number) => JSX.Element) => (
    <div className="card" style={{ overflow: "hidden" }}>
      {entries.map(({ m, i }, j) => (
        <div key={i} style={{ borderTop: j > 0 ? "1px solid var(--line2)" : "none" }}>
          {row(m, i)}
        </div>
      ))}
    </div>
  );

  /** 分组头右侧的收起/展开开关(百智云模型组与 MCP 组共用) */
  const collapseToggle = (open: boolean, toggle: () => void) => (
    <span
      className="hv-t1"
      onClick={toggle}
      style={{ fontSize: 11.5, color: "var(--t5)", cursor: "pointer", userSelect: "none" }}
    >
      {open ? "收起" : "展开"}
    </span>
  );

  // 未登录引导条(模型/MCP 页顶部;账号是主路径)
  const loginHint = bzStatus && !loggedIn && (
    <div className="card card-lg" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
      <BaizhiLogo size={16} />
      <span style={{ fontSize: 12.5, color: "var(--t3)", flex: 1 }}>登录百智云后可自动同步账号下的模型与 MCP,无需手工配置。</span>
      <button
        className="hv-acc"
        onClick={() => setActive("account")}
        style={{ ...whiteBtn, flex: "none", background: "var(--acc)", borderColor: "var(--acc)", color: "var(--onAcc)" }}
      >
        去登录
      </button>
    </div>
  );

  const modelsSection = () => {
    if (!desktop) {
      return (
        <div className="card card-lg" style={{ color: "var(--t4)", fontSize: 12.5, lineHeight: 1.7 }}>
          浏览器模式下配置只读:模型与 MCP 由桌面应用宿主管理。
        </div>
      );
    }
    if (!loaded) return <div style={{ fontSize: 12.5, color: "var(--t5)" }}>读取配置中…</div>;
    const entries = models.map((m, i) => ({ m, i }));
    const baizhi = entries.filter((e) => e.m.source === SOURCE_BAIZHI);
    const custom = entries.filter((e) => e.m.source !== SOURCE_BAIZHI);
    return (
      <>
        {loginHint}
        {/* 百智云组在前(主路径) */}
        <Section
          label={`${modelSourceLabel(SOURCE_BAIZHI)}${baizhi.length ? `(${baizhi.length})` : ""}`}
          action={baizhi.length > 0 ? collapseToggle(baizhiOpen, () => setBaizhiOpen((v) => !v)) : undefined}
        >
          {baizhi.length === 0 ? (
            <div style={emptyCard}>
              {loggedIn ? (
                <>
                  还没有同步的模型。到
                  <span className="hv-t1" onClick={() => setActive("account")} style={{ color: "var(--acc)", cursor: "pointer", fontWeight: 600 }}>
                    「百智云账号」
                  </span>
                  页点「同步模型与 MCP」即可拉取。
                </>
              ) : (
                "登录百智云并同步后,账号下的模型会出现在这里(重新同步时整组更新)。"
              )}
            </div>
          ) : (
            baizhiOpen && groupCard(baizhi, modelRow)
          )}
        </Section>
        {/* 自定义组(高级路径) */}
        <Section label="自定义模型" action={addBtn("添加模型", () => {
          setModels((ms) => [...ms, emptyModel()]);
          setExpanded(models.length); // 新行(追加在末尾)直接展开编辑
        })}>
          {custom.length === 0 ? (
            <div style={emptyCard}>手工接入其他服务商的模型(高级)。需要名称、接口地址、API Key 与模型标识。</div>
          ) : (
            groupCard(custom, modelRow)
          )}
        </Section>
      </>
    );
  };

  // ---- MCP:紧凑行 + 手风琴编辑 ----

  const mcpSummary = (m: McpEntry) => (m.type === "http" ? m.url.trim() : `${m.command} ${m.args}`.trim()) || "未配置";

  // MCP 紧凑行(i 恒 mcps 真实索引);fragment 返回,由 mcpGroupCard 包分隔线
  const mcpRow = (m: McpEntry, i: number) => {
    const isOpen = mcpExpanded === i;
    const disabled = !!m.extra?.disabled;
    return (
      <>
        <div
          className="hrow hv2"
          onClick={() => setMcpExpanded(isOpen ? null : i)}
          style={{ display: "flex", alignItems: "center", gap: 8, height: 40, padding: "0 14px", cursor: "pointer", userSelect: "none", opacity: disabled ? 0.5 : 1 }}
        >
          {m.source === SOURCE_BAIZHI && <BaizhiLogo size={14} />}
          <span className="ellipsis" style={{ fontSize: 12.5, fontFamily: MONO, color: m.name.trim() ? "var(--t1)" : "var(--t5)", flex: "none", maxWidth: 180 }}>
            {m.name.trim() || "未命名"}
          </span>
          <span style={pill}>{m.type}</span>
          <span className="ellipsis" style={{ fontSize: 11.5, color: "var(--t5)", fontFamily: MONO, minWidth: 0 }}>
            {mcpSummary(m)}
          </span>
          <span style={{ flex: 1 }} />
          <span className="row-acts" style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, flex: "none" }}>
            <span
              className="hv-t1"
              style={{ color: disabled ? "var(--t5)" : "var(--acc)", fontWeight: 600 }}
              onClick={(e) => {
                e.stopPropagation();
                const { disabled: _d, ...rest } = m.extra ?? {};
                const extra = disabled ? rest : { ...rest, disabled: true };
                patchMcp(i, { extra: Object.keys(extra).length ? extra : undefined });
              }}
            >
              {disabled ? "启用" : "停用"}
            </span>
            <span
              className="hv-err"
              style={{ color: "var(--t5)" }}
              onClick={(e) => {
                e.stopPropagation();
                setMcps((ms) => ms.filter((_, j) => j !== i));
                setMcpExpanded(null);
              }}
            >
              删除
            </span>
          </span>
          <span
            style={{ flex: "none", display: "inline-block", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s ease", fontSize: 9, color: "var(--t5)" }}
          >
            ▸
          </span>
        </div>
        {isOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 14px 14px" }}>
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
          </div>
        )}
      </>
    );
  };

  const mcpSection = () => {
    if (!desktop) {
      return (
        <div className="card card-lg" style={{ color: "var(--t4)", fontSize: 12.5, lineHeight: 1.7 }}>
          浏览器模式下配置只读:模型与 MCP 由桌面应用宿主管理。
        </div>
      );
    }
    if (!loaded) return <div style={{ fontSize: 12.5, color: "var(--t5)" }}>读取配置中…</div>;
    const entries = mcps.map((m, i) => ({ m, i }));
    const baizhi = entries.filter((e) => e.m.source === SOURCE_BAIZHI);
    const custom = entries.filter((e) => e.m.source !== SOURCE_BAIZHI);
    return (
      <>
        {loginHint}
        {/* 百智云 MCP 组在前(账号优先);当前网关未开通,同步暂不产出,组常为空 */}
        {baizhi.length > 0 && (
          <Section
            label={`${modelSourceLabel(SOURCE_BAIZHI)} MCP(${baizhi.length})`}
            action={collapseToggle(baizhiMcpOpen, () => setBaizhiMcpOpen((v) => !v))}
          >
            {baizhiMcpOpen && groupCard(baizhi, mcpRow)}
          </Section>
        )}
        {/* 自定义 MCP 组 */}
        <Section label="自定义 MCP" action={addBtn("添加 MCP", () => {
          setMcps((ms) => [...ms, emptyMcp()]);
          setMcpExpanded(mcps.length); // 新行追加末尾,直接展开
        })}>
          {custom.length === 0 ? (
            <div style={emptyCard}>未配置自定义 MCP 服务器(可选)。</div>
          ) : (
            groupCard(custom, mcpRow)
          )}
        </Section>
      </>
    );
  };

  // ---- 通用 ----

  const generalSection = () => (
    <>
      <Section label="外观">
        <div className="card card-lg" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", background: "var(--segBg)", borderRadius: 8, padding: 3, gap: 2 }}>
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
                boxShadow: "var(--segSh)",
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
                color: "var(--tDis)",
              }}
            >
              深色
            </button>
          </div>
          <span style={{ fontSize: 12, color: "var(--t5)" }}>深色模式即将支持。</span>
        </div>
      </Section>
      {desktop && isWindowsShell() && (
        <Section label="运行环境">
          <div className="card card-lg" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <select value={kernelEnv} onChange={(e) => setKernelEnv(e.target.value)} style={{ ...select, maxWidth: 280 }}>
              <option value="">Windows 本机</option>
              {wslDistros.map((d) => (
                <option key={d} value={"wsl:" + d}>
                  WSL · {d}
                </option>
              ))}
              {/* 已配置的发行版不在检测列表(被删除/WSL 异常)时仍要可见可保存 */}
              {kernelEnv.startsWith("wsl:") && !wslDistros.includes(kernelEnv.slice(4)) && (
                <option value={kernelEnv}>WSL · {kernelEnv.slice(4)}(未检测到)</option>
              )}
            </select>
            {wslDistros.length === 0 && (
              <span style={{ fontSize: 12, color: "var(--t5)" }}>未检测到 WSL 发行版(需要 WSL2,可用 `wsl --install` 安装)。</span>
            )}
            <span style={{ fontSize: 12, color: "var(--t5)", lineHeight: 1.7 }}>
              选择 WSL 后,任务在该发行版内执行(bash、git、node 等用发行版内安装的工具链)。
              工作区建议放在 WSL 内目录(如 ~/dev),/mnt/c 下的 Windows 目录会明显变慢。
              注意:会话列表按运行环境隔离(历史会话在另一环境中不可见);
              WSL 内访问不到 Windows 本机的 localhost 服务(如本机 HTTP 型 MCP)。
            </span>
          </div>
        </Section>
      )}
      {desktop && (
        <Section label="关于">
          <AboutCard version={hostVersion ?? "—"} update={update} onUpdateStatus={onUpdateStatus} />
        </Section>
      )}
    </>
  );

  const accountSection = () => (
    <>
      <Section label="百智云账号">
        <BaizhiCard
          status={bzStatus}
          statusErr={bzErr}
          refreshStatus={refreshBz}
          onSynced={applySynced}
          knownKeys={() => models.map((m) => m.api_key.trim()).filter((k) => k.startsWith("sk-"))}
          preselectNames={() => models.filter((m) => m.source === SOURCE_BAIZHI || !m.source).map((m) => m.name.trim())}
        />
      </Section>
      <Section label="MonkeyCode">
        <MonkeyCodeAccountCard
          connection={mcConnection}
          baizhiLoggedIn={loggedIn}
          onConnect={onConnectMc}
          onRetry={onRetryMc}
          onDisconnect={onDisconnectMc}
        />
      </Section>
    </>
  );

  const activeLabel = NAV.find((n) => n.key === active)?.label ?? "设置";

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, animation: "mcin .25s ease" }}>
      {/* 左侧分类导航(设置态占满主窗口,此为最左栏) */}
      <div style={{ width: 168, flex: "none", background: "var(--side)", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 2, padding: "0 10px 12px" }}>
        {/* macOS 壳:红绿灯落在最左栏顶部,预留拖拽区(与主侧栏同一组件,切换不跳动) */}
        <MacDragSpacer />
        <div
          className="hv"
          onClick={onClose}
          style={{ display: "flex", alignItems: "center", gap: 7, height: 30, padding: "0 9px", borderRadius: 6, cursor: "pointer", userSelect: "none", fontSize: 12.5, color: "var(--t3)", fontWeight: 600 }}
        >
          <IconBack size={10} color="var(--t3)" />
          返回
        </div>
        <div style={{ height: 6 }} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: "var(--t4)", padding: "2px 9px 6px" }}>设置</span>
        {NAV.filter((n) => n.key !== "browser" || caps?.browser_ext === true).map((n) => {
          const activeNow = active === n.key;
          const Icon = n.icon;
          return (
            <div
              key={n.key}
              className={activeNow ? undefined : "hv"}
              onClick={() => setActive(n.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                height: 30,
                padding: "0 9px",
                borderRadius: 6,
                cursor: "pointer",
                userSelect: "none",
                fontSize: 12.5,
                background: activeNow ? "var(--accSel)" : "transparent",
                color: activeNow ? "var(--accSelT)" : "var(--t2)",
                fontWeight: activeNow ? 600 : 400,
              }}
            >
              <Icon size={13} color={activeNow ? "var(--accSelT)" : "var(--t4)"} />
              {n.label}
            </div>
          );
        })}
      </div>

      {/* 内容区 + 保存条 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          <div key={active} style={{ maxWidth: 640, margin: "0 auto", padding: "24px 32px 40px", display: "flex", flexDirection: "column", gap: 18, animation: "mcin .18s ease" }}>
            <span style={{ fontSize: 17, fontWeight: 800 }}>{activeLabel}</span>
            {active === "account" && accountSection()}
            {active === "models" && modelsSection()}
            {active === "mcp" && mcpSection()}
            {active === "browser" && <BrowserExtCard />}
            {active === "general" && generalSection()}
            {err && !dirty && <div style={{ fontSize: 12.5, color: "var(--err)" }}>{err}</div>}
          </div>
        </div>
        {dirty && (
          <div style={{ flex: "none", borderTop: "1px solid var(--line)", background: "var(--card)", padding: "10px 20px", display: "flex", alignItems: "center", gap: 12, animation: "mcin .15s ease" }}>
            <span style={{ fontSize: 12.5, color: "var(--t3)" }}>有未保存的更改,保存后内核将重启(会话在磁盘不丢失)。</span>
            {err && <span className="ellipsis" style={{ fontSize: 12, color: "var(--err)" }}>{err}</span>}
            <span style={{ flex: 1 }} />
            <button className="hv" onClick={discard} style={{ ...whiteBtn, flex: "none" }} disabled={saving}>
              放弃更改
            </button>
            <button
              className="hv-acc"
              onClick={() => !saving && void save()}
              style={{
                height: 28,
                border: "none",
                borderRadius: 8,
                background: "var(--acc)",
                color: "var(--onAcc)",
                fontWeight: 700,
                fontSize: 12.5,
                padding: "0 18px",
                cursor: saving ? "default" : "pointer",
                opacity: saving ? 0.6 : 1,
                boxShadow: "var(--accSh)",
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: "none",
              }}
            >
              {saving && (
                <span style={{ width: 11, height: 11, border: "1.5px solid var(--onAcc)", borderTopColor: "transparent", borderRadius: "50%", animation: "mcspin .9s linear infinite", display: "inline-block" }} />
              )}
              {saving ? "保存并重启内核中…" : "保存"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
