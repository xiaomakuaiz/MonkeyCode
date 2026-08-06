// 设置页「账号」分区:百智云账号(短信/微信扫码登录、模型与 MCP 同步)+
// MonkeyCode 云账号(桥接/账密登录、用量/签到/邀请、会员模型同步)。
//
// 状态语义:
// - 两路登录态挂载时并发自取(baizhi_status / mc_status),不进全局轮询;
// - 百智云登录成功顺带桥接 MonkeyCode(mc_login 走同一账号的 OAuth),
//   桥接失败不阻断——MonkeyCode 卡保留手动「连接」入口;
// - 断开 MonkeyCode 必须先吊销会员模型密钥再清会话(disconnectMc 收口,
//   顺序由 lib 与本组件测试双重钉住);
// - 同步(baizhi_sync / mc_models_sync)结果经 onSyncResult 交
//   SettingsView.applySync 并入草稿;干净表单+无任务在跑时那边自动保存,
//   否则回退保存条——结果行按 autoSaved/blocked 说明白落到哪一步了
//   (密钥复用 knownKeys 联动留后续版本)。
import { Check, Copy } from "lucide-react";
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
import { copyText } from "@/lib/util/clipboard";
import { LoginPanel, PasswordForm } from "./LoginPanel";
import { UsagePanel } from "./UsagePanel";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 用户 ID 掩码:短串原样,长串取头 8 + 尾 6(与移动端「我的」页同口径,
 *  mobile/app/(tabs)/profile.tsx maskUserId)——只为不撑爆行宽,复制的、
 *  title 里的都是完整原值。 */
export function maskUserId(id: string): string {
  const v = id.trim();
  return v.length <= 16 ? v : `${v.slice(0, 8)}...${v.slice(-6)}`;
}

/** 用户 ID 一键复制(移动端是整行可点 + toast,桌面无 toast:图标就地
 *  翻成对勾 1.8 秒,与用量面板的「复制邀请链接」同一反馈语汇)。 */
function UserIdChip({ id }: { id: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    copyText(id);
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button
      type="button"
      title={t("account.mc.userIdTitle", { id })}
      aria-label={copied ? t("account.mc.userIdCopied") : t("account.mc.copyUserId")}
      className="flex min-w-0 cursor-pointer items-center gap-1 font-mono text-xs text-base-content/50 transition-colors hover:text-base-content"
      onClick={copy}
    >
      {copied ? (
        <Check size={11} strokeWidth={2} aria-hidden className="shrink-0 text-success" />
      ) : (
        <Copy size={11} strokeWidth={1.75} aria-hidden className="shrink-0" />
      )}
      <span className="truncate">{maskUserId(id)}</span>
    </button>
  );
}

/** profile 字段对壳不透明,展示名尽力提取常见字段;提不出返回空串。 */
export function profileName(p?: Record<string, unknown>): string {
  for (const k of ["name", "nickname", "username", "phone", "email"]) {
    const v = p?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

type Msg = { text: string; error?: boolean } | null;

/** applySync 的回执:跳过名单 + 自动保存结论(blocked = 为何回退保存条)。 */
export interface SyncApplied {
  skipped: string[];
  autoSaved: boolean;
  blocked?: "dirty" | "busy";
}

type T = ReturnType<typeof useI18n>["t"];

/** 同步结果行尾注:自动保存已生效 / 因何需要手动保存。applied 缺席
 * (浏览器模式等没接宿主)退回中性的「保存后生效」。 */
function syncOutcome(t: T, applied: SyncApplied | undefined | void): string {
  if (!applied) return t("account.sync.manualSave");
  if (applied.autoSaved) return t("account.sync.autoSaved");
  if (applied.blocked === "dirty") return t("account.sync.blockedDirty");
  if (applied.blocked === "busy") return t("account.sync.blockedBusy");
  return t("account.sync.manualSave");
}

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
  autoSyncToken = 0,
}: {
  status: BaizhiStatus;
  onChanged: () => Promise<void>;
  /** 同步结果交宿主并入设置草稿;回执带跳过名单与自动保存结论(卡内外显) */
  onResult?: (r: BaizhiSyncResult) => SyncApplied | undefined | void;
  /** 登录真实事件的自动同步信号(宿主 bump;0 = 无,打开设置读到既有登录态
   * 不触发)。卡在登录后才挂载,同步逻辑又在卡内,登录瞬间够不着——经
   * token 延迟触发(旧 UI「登录成功即自动同步」用户拍板行为的 ui-next 版) */
  autoSyncToken?: number;
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
          syncOutcome(t, applied) +
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

  // 登录即自动同步:token 变化(含挂载时已非 0——refresh 与 bump 同批提交
  // 时卡首挂载就带着新值)触发一次;sync 自带 syncing 态,不需再防抖
  useEffect(() => {
    if (autoSyncToken > 0) void sync();
    // sync 每渲染新引用但行为稳定,只认 token 边沿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSyncToken]);

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
  baizhiLoggedIn,
  bridgeErr,
  onChanged,
  onLoggedIn,
  onResult,
  autoSyncToken = 0,
}: {
  status: McStatus | null;
  /** 百智云是否已登录:决定「连接」主钮出不出(桥接要拿百智云会话去换
   *  MonkeyCode 会话,未登录时点它必失败,不摆这个死钮) */
  baizhiLoggedIn: boolean;
  /** 百智云登录后自动桥接的失败信息(不阻断,卡内外显并留手动重试) */
  bridgeErr: string;
  onChanged: () => Promise<void>;
  /** 账密登录成功:宿主刷新状态并起一次会员模型同步(与桥接登录同待遇) */
  onLoggedIn: () => void;
  /** 同步结果交宿主并入设置草稿;回执带跳过名单与自动保存结论(卡内外显) */
  onResult?: (r: McModelsSyncResult) => SyncApplied | undefined | void;
  /** 登录/桥接真实事件的自动同步信号(语义同 BaizhiCard.autoSyncToken) */
  autoSyncToken?: number;
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
      setMsg({ text: t("account.mc.syncDone", { models: r.models.length }) + syncOutcome(t, applied) + notes + skipped });
    } catch (e) {
      setMsg({ text: errMsg(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const connected = !!status?.logged_in;
  const user = status?.user;
  const userName = user?.name || user?.username || user?.email || t("account.loggedIn");

  // 登录/桥接即自动同步(语义同 BaizhiCard):connected 现值判断不进依赖
  // ——桥接流程 refresh 先落(connected 翻真)再 bump,只认 token 边沿
  useEffect(() => {
    if (autoSyncToken > 0 && connected) void sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSyncToken]);

  if (!connected) {
    return (
      <AccountCard
        logo="/logo.png"
        title={t("account.notConnected")}
        subtitle={
          <span className="truncate">
            {baizhiLoggedIn ? t("account.mc.notConnected") : t("account.mc.notConnectedIdle")}
          </span>
        }
        actions={
          baizhiLoggedIn && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy === "connect"}
              onClick={() => void connect()}
            >
              {busy === "connect" && <span className="loading loading-spinner loading-xs" aria-hidden />}
              {busy === "connect" ? t("account.mc.connecting") : t("account.mc.connect")}
            </button>
          )
        }
      >
        {bridgeErr && (
          <span role="alert" className="text-xs text-error">
            {t("account.mc.connectFailed", { message: bridgeErr })}
          </span>
        )}
        {/* 账密登录:不经百智云的手动路径(桥接失败/私有化/换账号)。入口与
            表单都在本卡内——它登的是 MonkeyCode 账号,挂在百智云登录卡下方
            是把两块账号串到一处(用户报障 2026-08-06) */}
        {pwOpen ? (
          <div className="flex max-w-sm flex-col gap-2 border-t border-base-300 pt-3">
            <p className="text-xs text-base-content/60">{t("account.pw.hint")}</p>
            <PasswordForm onLoggedIn={onLoggedIn} />
            <button
              type="button"
              className="btn btn-link btn-xs self-start px-0 font-normal text-base-content/50 no-underline hover:text-base-content"
              onClick={() => setPwOpen(false)}
            >
              {t("account.pw.collapse")}
            </button>
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
      subtitle={
        // 副行 = 身份的次级事实:主机名 + 用户 ID(移动端把 ID 摆在邮箱行
        // 下方同一身份块,桌面卡是横向的,并入同一行)
        <>
          <span className="truncate font-mono text-xs text-base-content/50">{status?.host}</span>
          {user?.id && (
            <>
              <span aria-hidden className="shrink-0 text-base-content/30">
                ·
              </span>
              <UserIdChip id={user.id} />
            </>
          )}
        </>
      }
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
  /** 同步结果并入设置草稿(SettingsView.applySync);回执含跳过名单与自动保存结论 */
  onSyncResult?: (r: BaizhiSyncResult | McModelsSyncResult) => SyncApplied | undefined | void;
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

  // 登录真实事件的自动同步信号(0 = 无;只在下面两个登录回调里 bump,
  // 打开设置读到既有登录态不触发)——「登录成功即自动同步」是旧 UI 用户
  // 拍板行为,ui-next 首版漏迁(2026-08-06 用户报障:登录后模型/MCP 没
  // 同步上,实为压根没触发)
  const [bzSyncToken, setBzSyncToken] = useState(0);
  const [mcSyncToken, setMcSyncToken] = useState(0);

  /** 百智云真实登录事件:先刷出已登录形态并起百智云同步,再尝试桥接
   *  MonkeyCode(同一账号的 OAuth,登录一次两边都通),桥接成功顺带起
   *  会员模型同步。 */
  const onBaizhiLoggedIn = useCallback(async () => {
    setBridgeErr("");
    await refresh();
    setBzSyncToken((n) => n + 1);
    try {
      await mcLogin();
      await refresh();
      setMcSyncToken((n) => n + 1);
    } catch (e) {
      if (alive.current) setBridgeErr(errMsg(e));
      await refresh();
    }
  }, [refresh]);

  const onMcLoggedIn = useCallback(async () => {
    await refresh();
    setMcSyncToken((n) => n + 1);
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
              <BaizhiCard status={bz} onChanged={refresh} onResult={onSyncResult} autoSyncToken={bzSyncToken} />
            ) : (
              <BaizhiLoginCard>
                <LoginPanel onBaizhiLoggedIn={() => void onBaizhiLoggedIn()} />
              </BaizhiLoginCard>
            )}
          </div>
          {/* MonkeyCode 组恒在(2026-08-06 用户定案):两个账号 = 两块,
              MonkeyCode 的连接/账密登录入口都在本块内。未登录时卡里不摆
              「连接」死钮——桥接需要百智云会话,只留账密登录这条手动路径 */}
          <div className="flex flex-col gap-1.5">
            <h3 className="px-1 text-xs font-bold text-base-content/60">{t("account.mc.title")}</h3>
            <McCard
              status={mc}
              baizhiLoggedIn={!!bz?.logged_in}
              bridgeErr={bridgeErr}
              onChanged={refresh}
              onLoggedIn={() => void onMcLoggedIn()}
              onResult={onSyncResult}
              autoSyncToken={mcSyncToken}
            />
          </div>
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
