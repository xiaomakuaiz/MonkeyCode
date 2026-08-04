// 设置页「账号」分区:百智云账号(短信/微信扫码登录、模型与 MCP 同步)+
// MonkeyCode 云账号(桥接/账密登录、用量/签到/邀请、会员模型同步)。
//
// 状态语义:
// - 两路登录态挂载时并发自取(baizhi_status / mc_status),不进全局轮询;
// - 百智云登录成功顺带桥接 MonkeyCode(mc_login 走同一账号的 OAuth),
//   桥接失败不阻断——MonkeyCode 卡保留手动「连接」入口;
// - 断开 MonkeyCode 必须先吊销会员模型密钥再清会话(disconnectMc 收口,
//   顺序由 lib 与本组件测试双重钉住);
// - 同步(baizhi_sync / mc_models_sync)本期只做触发与结果提示,不落盘。
//   与设置表单的深度联动(密钥复用 knownKeys、结果并入模型页)留接口:
//   宿主可传 onSyncResult 接走原始结果,后续版本在 SettingsView 接线。
import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";
import {
  baizhiLogout,
  baizhiStatus,
  baizhiSync,
  disconnectMc,
  mcLogin,
  mcStatus,
  type BaizhiStatus,
  type BaizhiSyncResult,
  type McModelsSyncResult,
  type McStatus,
  mcModelsSync,
} from "@/lib/ipc/account";
import { inDesktopShell } from "@/lib/ipc/ipc";
import { LoginPanel } from "./LoginPanel";
import { UsagePanel } from "./UsagePanel";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** profile 字段对壳不透明,展示名尽力提取常见字段;提不出返回空串。 */
export function profileName(p?: Record<string, unknown>): string {
  for (const k of ["name", "nickname", "username", "phone", "email"]) {
    const v = p?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

type Msg = { text: string; error?: boolean } | null;

function MsgLine({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <span role={msg.error ? "alert" : "status"} className={msg.error ? "text-xs text-error" : "text-xs text-base-content/60"}>
      {msg.text}
    </span>
  );
}

/** 百智云账号卡(已登录形态)。 */
function BaizhiCard({
  status,
  onChanged,
  onResult,
}: {
  status: BaizhiStatus;
  onChanged: () => Promise<void>;
  onResult?: (r: BaizhiSyncResult) => void;
}) {
  const { t } = useI18n();
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const sync = async () => {
    setSyncing(true);
    setMsg(null);
    try {
      // knownKeys 空:设置表单的密钥复用属于「并入表单」联动,与结果消费
      // 一起留给后续版本(见文件头);壳会复用/新建网关密钥并在结果里说明
      const r = await baizhiSync([]);
      onResult?.(r);
      const notes = r.notes?.length ? ` ${r.notes.join("；")}` : "";
      setMsg({
        text:
          t("account.baizhi.syncDone", {
            models: r.models.length,
            mcp: Object.keys(r.mcp_servers ?? {}).length,
          }) + notes,
      });
    } catch (e) {
      setMsg({ text: errMsg(e), error: true });
    } finally {
      setSyncing(false);
    }
  };

  const logout = async () => {
    setMsg(null);
    try {
      await baizhiLogout();
      await onChanged();
    } catch (e) {
      setMsg({ text: errMsg(e), error: true });
    }
  };

  return (
    <div className="rounded-box border border-base-300 bg-base-100">
      <div className="flex flex-col gap-2 p-4">
        <h2 className="text-sm font-semibold">{t("account.baizhi.title")}</h2>
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{profileName(status.profile) || t("account.loggedIn")}</span>
          <span className="truncate font-mono text-xs text-base-content/50">{status.host}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={syncing} onClick={() => void sync()}>
            {syncing && <span className="loading loading-spinner loading-xs" aria-hidden />}
            {syncing ? t("account.syncing") : t("account.baizhi.sync")}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void logout()}>
            {t("account.baizhi.logout")}
          </button>
        </div>
        <MsgLine msg={msg} />
      </div>
    </div>
  );
}

/** MonkeyCode 云账号卡:未连=连接入口;已连=账号信息 + 用量面板 +
 *  会员模型同步 + 断开(先 revoke 再 logout)。 */
function McCard({
  status,
  bridgeErr,
  onChanged,
  onResult,
}: {
  status: McStatus | null;
  /** 百智云登录后自动桥接的失败信息(不阻断,卡内外显并留手动重试) */
  bridgeErr: string;
  onChanged: () => Promise<void>;
  onResult?: (r: McModelsSyncResult) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<"connect" | "disconnect" | "sync" | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const connect = async () => {
    setBusy("connect");
    setMsg(null);
    try {
      await mcLogin();
      await onChanged();
    } catch (e) {
      setMsg({ text: errMsg(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setMsg(null);
    try {
      const { warning } = await disconnectMc();
      await onChanged();
      if (warning) setMsg({ text: warning, error: true });
    } catch (e) {
      setMsg({ text: errMsg(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy("sync");
    setMsg(null);
    try {
      const r: McModelsSyncResult = await mcModelsSync();
      onResult?.(r);
      const notes = r.notes?.length ? ` ${r.notes.join("；")}` : "";
      setMsg({ text: t("account.mc.syncDone", { models: r.models.length }) + notes });
    } catch (e) {
      setMsg({ text: errMsg(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const connected = !!status?.logged_in;
  const user = status?.user;
  const userName = user?.name || user?.username || user?.email || t("account.loggedIn");

  return (
    <div className="rounded-box border border-base-300 bg-base-100">
      <div className="flex flex-col gap-2 p-4">
        <h2 className="text-sm font-semibold">{t("account.mc.title")}</h2>
        {!connected ? (
          <>
            <p className="text-xs text-base-content/60">{t("account.mc.notConnected")}</p>
            {bridgeErr && (
              <span role="alert" className="text-xs text-error">
                {t("account.mc.connectFailed", { message: bridgeErr })}
              </span>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy === "connect"}
                onClick={() => void connect()}
              >
                {busy === "connect" && <span className="loading loading-spinner loading-xs" aria-hidden />}
                {busy === "connect" ? t("account.mc.connecting") : t("account.mc.connect")}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{userName}</span>
              <span className="truncate font-mono text-xs text-base-content/50">{status?.host}</span>
            </div>
            <UsagePanel userId={user?.id} />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-sm" disabled={busy === "sync"} onClick={() => void sync()}>
                {busy === "sync" && <span className="loading loading-spinner loading-xs" aria-hidden />}
                {busy === "sync" ? t("account.syncing") : t("account.mc.sync")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy === "disconnect"}
                onClick={() => void disconnect()}
              >
                {busy === "disconnect" ? t("account.mc.disconnecting") : t("account.mc.disconnect")}
              </button>
            </div>
          </>
        )}
        <MsgLine msg={msg} />
      </div>
    </div>
  );
}

export function AccountSection({
  onSyncResult,
}: {
  /** 同步结果的外接口(留给设置表单联动;本期 SettingsView 不接线) */
  onSyncResult?: (r: BaizhiSyncResult | McModelsSyncResult) => void;
} = {}) {
  const { t } = useI18n();
  const inShell = inDesktopShell();
  const [bz, setBz] = useState<BaizhiStatus | null>(null);
  const [mc, setMc] = useState<McStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [statusErr, setStatusErr] = useState("");
  const [bridgeErr, setBridgeErr] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const [b, m] = await Promise.allSettled([baizhiStatus(), mcStatus()]);
    if (!alive.current) return;
    // 单路失败不拖垮另一路:失败信息合并外显,成功的一路照常渲染
    const errs: string[] = [];
    if (b.status === "fulfilled") setBz(b.value);
    else errs.push(errMsg(b.reason));
    if (m.status === "fulfilled") setMc(m.value);
    else errs.push(errMsg(m.reason));
    setStatusErr(errs.join("；"));
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (inShell) void refresh();
  }, [inShell, refresh]);

  /** 百智云真实登录事件:先刷出已登录形态,再尝试桥接 MonkeyCode
   *  (同一账号的 OAuth,登录一次两边都通),桥接结果二次刷新。 */
  const onBaizhiLoggedIn = useCallback(async () => {
    setBridgeErr("");
    await refresh();
    try {
      await mcLogin();
    } catch (e) {
      if (alive.current) setBridgeErr(errMsg(e));
    }
    await refresh();
  }, [refresh]);

  const onMcLoggedIn = useCallback(async () => {
    await refresh();
  }, [refresh]);

  if (!inShell) {
    return (
      <section aria-label={t("settings.nav.account")} className="flex max-w-xl flex-col gap-3">
        <div role="alert" className="alert alert-warning alert-soft max-w-md text-xs">
          {t("account.browserOnly")}
        </div>
      </section>
    );
  }

  const anyLoggedIn = !!bz?.logged_in || !!mc?.logged_in;

  return (
    <section aria-label={t("settings.nav.account")} className="flex max-w-xl flex-col gap-3">
      {statusErr && (
        <div role="alert" className="alert alert-error alert-soft max-w-md text-xs">
          <span>{t("account.statusFailed", { message: statusErr })}</span>
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => void refresh()}>
            {t("account.retry")}
          </button>
        </div>
      )}
      {!loaded && !statusErr && <span className="text-xs text-base-content/50">{t("account.loading")}</span>}
      {loaded &&
        (!anyLoggedIn ? (
          <LoginPanel withPassword onBaizhiLoggedIn={() => void onBaizhiLoggedIn()} onMcLoggedIn={() => void onMcLoggedIn()} />
        ) : (
          <>
            {bz?.logged_in ? (
              <BaizhiCard status={bz} onChanged={refresh} onResult={onSyncResult} />
            ) : (
              // MonkeyCode 已连而百智云未登录(账密登录路径):补百智云登录
              // 入口,但不再给账密入口(MC 已连,重复登录只添乱)
              <LoginPanel withPassword={false} onBaizhiLoggedIn={() => void onBaizhiLoggedIn()} onMcLoggedIn={() => void onMcLoggedIn()} />
            )}
            <McCard status={mc} bridgeErr={bridgeErr} onChanged={refresh} onResult={onSyncResult} />
          </>
        ))}
    </section>
  );
}
