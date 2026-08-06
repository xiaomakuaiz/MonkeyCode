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
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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
import { LoginPanel, PasswordForm } from "./LoginPanel";
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

/** 账号卡壳(旧 UI 设置屏同款形态):logo + 标题/状态徽标 + 副行在左,
 *  动作钮靠右;扩展内容(用量面板/提示行)另起一行。 */
function AccountCard({
  logo,
  title,
  badge,
  subtitle,
  actions,
  children,
}: {
  logo: string;
  title: string;
  badge?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="card card-border bg-base-100">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <img src={logo} alt="" aria-hidden draggable={false} className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{title}</span>
              {badge}
            </div>
            {subtitle && (
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-base-content/60">{subtitle}</div>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
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
  /** 同步结果交宿主并入设置草稿;返回跨组撞名的跳过名单(卡内外显) */
  onResult?: (r: BaizhiSyncResult) => { skipped: string[] } | undefined | void;
}) {
  const { t } = useI18n();
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const sync = async () => {
    setSyncing(true);
    setMsg(null);
    try {
      // knownKeys 空:密钥复用联动留给后续版本;壳会复用/新建网关密钥
      const r = await baizhiSync([]);
      const applied = onResult?.(r);
      const notes = r.notes?.length ? ` ${r.notes.join("；")}` : "";
      const skipped = applied && applied.skipped.length ? ` ${t("account.sync.skipped", { names: applied.skipped.join("、") })}` : "";
      setMsg({
        text:
          t("account.baizhi.syncDone", {
            models: r.models.length,
            mcp: Object.keys(r.mcp_servers ?? {}).length,
          }) +
          notes +
          skipped,
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
    <AccountCard
      logo="/baizhi-logo.png"
      // 组头已表明「百智云账号」,卡头显登录身份,不再重复产品名
      title={profileName(status.profile) || t("account.loggedIn")}
      badge={<span className="badge badge-success badge-soft badge-xs shrink-0">{t("account.loggedIn")}</span>}
      subtitle={<span className="truncate font-mono text-xs text-base-content/50">{status.host}</span>}
      actions={
        <>
          <button type="button" className="btn btn-sm" disabled={syncing} onClick={() => void sync()}>
            {syncing && <span className="loading loading-spinner loading-xs" aria-hidden />}
            {syncing ? t("account.syncing") : t("account.baizhi.sync")}
          </button>
          <button type="button" className="btn btn-ghost btn-sm text-base-content/60" onClick={() => void logout()}>
            {t("account.baizhi.logout")}
          </button>
        </>
      }
    >
      <MsgLine msg={msg} />
    </AccountCard>
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
  /** 同步结果交宿主并入设置草稿;返回跨组撞名的跳过名单(卡内外显) */
  onResult?: (r: McModelsSyncResult) => { skipped: string[] } | undefined | void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<"connect" | "disconnect" | "sync" | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [pwOpen, setPwOpen] = useState(false);

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
      const applied = onResult?.(r);
      const notes = r.notes?.length ? ` ${r.notes.join("；")}` : "";
      const skipped = applied && applied.skipped.length ? ` ${t("account.sync.skipped", { names: applied.skipped.join("、") })}` : "";
      setMsg({ text: t("account.mc.syncDone", { models: r.models.length }) + notes + skipped });
    } catch (e) {
      setMsg({ text: errMsg(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const connected = !!status?.logged_in;
  const user = status?.user;
  const userName = user?.name || user?.username || user?.email || t("account.loggedIn");

  if (!connected) {
    return (
      <AccountCard
        logo="/logo.png"
        title={t("account.notConnected")}
        subtitle={<span className="truncate">{t("account.mc.notConnected")}</span>}
        actions={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy === "connect"}
            onClick={() => void connect()}
          >
            {busy === "connect" && <span className="loading loading-spinner loading-xs" aria-hidden />}
            {busy === "connect" ? t("account.mc.connecting") : t("account.mc.connect")}
          </button>
        }
      >
        {bridgeErr && (
          <span role="alert" className="text-xs text-error">
            {t("account.mc.connectFailed", { message: bridgeErr })}
          </span>
        )}
        {/* 账密登录:不经百智云的手动路径(桥接失败/私有化/换账号) */}
        {pwOpen ? (
          <div className="max-w-sm border-t border-base-300 pt-2">
            <p className="pt-1 text-xs text-base-content/60">{t("account.pw.hint")}</p>
            <PasswordForm onLoggedIn={() => void onChanged()} />
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-link btn-xs self-start px-0 font-normal text-base-content/50 no-underline hover:text-base-content"
            onClick={() => setPwOpen(true)}
          >
            {t("account.pw.entry")}
          </button>
        )}
        <MsgLine msg={msg} />
      </AccountCard>
    );
  }
  return (
    <AccountCard
      logo="/logo.png"
      // 组头已表明「MonkeyCode 云端」,卡头显登录身份
      title={userName}
      badge={<span className="badge badge-success badge-soft badge-xs shrink-0">{t("account.loggedIn")}</span>}
      subtitle={<span className="truncate font-mono text-xs text-base-content/50">{status?.host}</span>}
      actions={
        <>
          <button type="button" className="btn btn-sm" disabled={busy === "sync"} onClick={() => void sync()}>
            {busy === "sync" && <span className="loading loading-spinner loading-xs" aria-hidden />}
            {busy === "sync" ? t("account.syncing") : t("account.mc.sync")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm text-base-content/60"
            disabled={busy === "disconnect"}
            onClick={() => void disconnect()}
          >
            {busy === "disconnect" ? t("account.mc.disconnecting") : t("account.mc.disconnect")}
          </button>
        </>
      }
    >
      {/* 权益面板归卡内次级区块,分隔线切开身份行与权益块 */}
      <div className="border-t border-base-300 pt-3">
        <UsagePanel userId={user?.id} />
      </div>
      <MsgLine msg={msg} />
    </AccountCard>
  );
}

export function AccountSection({
  onSyncResult,
}: {
  /** 同步结果并入设置草稿(SettingsView.applySync);返回跨组撞名跳过名单 */
  onSyncResult?: (r: BaizhiSyncResult | McModelsSyncResult) => { skipped: string[] } | undefined | void;
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
      {loaded && (
        <>
          {/* 百智云组(主路径):已登录成账号卡,未登录成登录卡 */}
          <div className="flex flex-col gap-1.5">
            <h3 className="px-1 text-xs font-bold text-base-content/60">{t("account.baizhi.title")}</h3>
            {bz?.logged_in ? (
              <BaizhiCard status={bz} onChanged={refresh} onResult={onSyncResult} />
            ) : (
              // MC 已连时不再给账密入口(重复登录只添乱);全未登录时给
              <BaizhiLoginCard>
                <LoginPanel
                  withPassword={!mc?.logged_in}
                  onBaizhiLoggedIn={() => void onBaizhiLoggedIn()}
                  onMcLoggedIn={() => void onMcLoggedIn()}
                />
              </BaizhiLoginCard>
            )}
          </div>
          {/* MonkeyCode 组:任一登录后才出(全未登录时百智云登录顺带桥接,
              不提前摆一张未连接卡分散主路径) */}
          {anyLoggedIn && (
            <div className="flex flex-col gap-1.5">
              <h3 className="px-1 text-xs font-bold text-base-content/60">{t("account.mc.title")}</h3>
              <McCard status={mc} bridgeErr={bridgeErr} onChanged={refresh} onResult={onSyncResult} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** 百智云未登录卡壳:纯卡片承载登录面板(组头已表明身份,卡内不再放头)。 */
function BaizhiLoginCard({ children }: { children: ReactNode }) {
  return (
    <div className="card card-border bg-base-100">
      {/* 登录面板居中:卡宽 > 面板宽,靠左会剩一大块死白 */}
      <div className="p-4">
        <div className="mx-auto w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
