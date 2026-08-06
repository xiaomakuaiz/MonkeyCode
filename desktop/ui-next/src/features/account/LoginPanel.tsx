// 未登录面板:百智云登录两 tab(微信扫码/短信验证码)+ MonkeyCode 账号
// 密码登录入口(mc_password_login,不经百智云)。
//
// - 微信扫码:状态机在 lib/account/wechatFlow(可注入 poll/时钟),本层只
//   消费快照;expired/error 在二维码上覆「重新获取」,canceled 由状态机
//   自行回待扫。
// - 短信:手机号弱校验(1[3-9] 开头 11 位)+ 60s 倒计时发码按钮。
// - 登录成功只报边沿(onBaizhiLoggedIn / onMcLoggedIn),状态刷新与
//   MonkeyCode 桥接由宿主 AccountSection 统一处理。
import { useEffect, useRef, useState } from "react";

import { createWechatFlow, WECHAT_IDLE, type WechatFlow, type WechatSnapshot } from "@/lib/account/wechatFlow";
import { useI18n } from "@/lib/i18n";
import { baizhiLogin, baizhiSendCode, baizhiWechatPoll, baizhiWechatStart, mcPasswordLogin } from "@/lib/ipc/account";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const phoneValid = (v: string) => /^1[3-9]\d{9}$/.test(v);
const codeValid = (v: string) => /^\d{4,6}$/.test(v);

/** 微信扫码卡:二维码 + 状态遮罩。 */
function WechatTab({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { t } = useI18n();
  const [snap, setSnap] = useState<WechatSnapshot>(WECHAT_IDLE);
  const flowRef = useRef<WechatFlow | null>(null);
  // 登录回调走 ref:ok 只触发一次,且不因宿主重建回调而重跑 effect
  const loggedInRef = useRef(onLoggedIn);
  loggedInRef.current = onLoggedIn;

  useEffect(() => {
    const flow = createWechatFlow({ start: baizhiWechatStart, poll: baizhiWechatPoll, onChange: setSnap });
    flowRef.current = flow;
    void flow.begin(); // 进 tab 即自动拉码
    return () => flow.dispose(); // 切走/卸载作废轮询
  }, []);

  useEffect(() => {
    if (snap.phase === "ok") loggedInRef.current();
  }, [snap.phase]);

  const hintKey = {
    idle: "account.wechat.loading",
    loading: "account.wechat.loading",
    waiting: "account.wechat.waiting",
    scanned: "account.wechat.scanned",
    ok: "account.wechat.scanned",
    expired: "account.wechat.expired",
    error: "account.wechat.error",
  } as const;
  const needRetry = snap.phase === "expired" || snap.phase === "error";

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <div className="card card-border relative size-42 items-center justify-center overflow-hidden">
        {snap.qr && (
          <img
            src={snap.qr}
            alt={t("account.wechat.qrAlt")}
            draggable={false}
            className={needRetry ? "size-full object-contain opacity-30 blur-sm" : "size-full object-contain"}
          />
        )}
        {!snap.qr && !needRetry && <span className="loading loading-spinner loading-sm" aria-hidden />}
        {needRetry && (
          <button
            type="button"
            className="btn btn-sm absolute"
            onClick={() => void flowRef.current?.begin()}
          >
            {t("account.wechat.refresh")}
          </button>
        )}
      </div>
      <span className={snap.phase === "scanned" ? "text-xs font-semibold text-success" : "text-xs text-base-content/60"}>
        {t(hintKey[snap.phase])}
      </span>
      {snap.error && (
        <span role="alert" className="text-xs text-error">
          {snap.error}
        </span>
      )}
    </div>
  );
}

/** 短信验证码卡:手机号 + 验证码 + 60s 倒计时发码按钮。 */
function SmsTab({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { t } = useI18n();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((v) => Math.max(0, v - 1)), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const send = async () => {
    setErr("");
    if (!phoneValid(phone)) {
      setErr(t("account.error.phone"));
      return;
    }
    setSending(true);
    try {
      await baizhiSendCode(phone);
      setCountdown(60);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSending(false);
    }
  };

  const login = async () => {
    setErr("");
    if (!phoneValid(phone)) {
      setErr(t("account.error.phone"));
      return;
    }
    if (!codeValid(code)) {
      setErr(t("account.error.code"));
      return;
    }
    setBusy(true);
    try {
      await baizhiLogin(phone, code);
      onLoggedIn(); // 之后本卡随宿主刷新卸载,不再碰本地 state
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 py-2">
      <fieldset className="fieldset">
        <legend className="fieldset-legend">{t("account.sms.phone")}</legend>
        <input
          className="input input-sm w-full"
          aria-label={t("account.sms.phone")}
          value={phone}
          placeholder={t("account.sms.phonePlaceholder")}
          inputMode="numeric"
          maxLength={11}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
        />
      </fieldset>
      <fieldset className="fieldset">
        <legend className="fieldset-legend">{t("account.sms.code")}</legend>
        <div className="flex gap-2">
          <input
            className="input input-sm flex-1"
            aria-label={t("account.sms.code")}
            value={code}
            placeholder={t("account.sms.codePlaceholder")}
            inputMode="numeric"
            maxLength={6}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={(e) => e.key === "Enter" && !busy && void login()}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={sending || countdown > 0}
            onClick={() => void send()}
          >
            {sending
              ? t("account.sms.sending")
              : countdown > 0
                ? t("account.sms.countdown", { seconds: countdown })
                : t("account.sms.send")}
          </button>
        </div>
      </fieldset>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void login()}>
          {busy && <span className="loading loading-spinner loading-xs" aria-hidden />}
          {busy ? t("account.sms.loggingIn") : t("account.sms.login")}
        </button>
        {err && (
          <span role="alert" className="text-xs text-error">
            {err}
          </span>
        )}
      </div>
    </div>
  );
}

/** MonkeyCode 账号密码登录(不经百智云;壳内自动 PoW)。导出给账号卡的
 *  「未连接」态复用(百智云已登录但桥接不可用/不同账号的手动路径)。 */
export function PasswordForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const login = async () => {
    setErr("");
    // 弱校验对齐壳侧:仅非空;password 不 trim(首尾空格是密码的一部分)
    if (!email.trim() || !password) {
      setErr(t("account.pw.error"));
      return;
    }
    setBusy(true);
    try {
      await mcPasswordLogin(email.trim(), password);
      onLoggedIn();
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 py-2">
      <fieldset className="fieldset">
        <legend className="fieldset-legend">{t("account.pw.email")}</legend>
        <input
          className="input input-sm w-full"
          aria-label={t("account.pw.email")}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </fieldset>
      <fieldset className="fieldset">
        <legend className="fieldset-legend">{t("account.pw.password")}</legend>
        <input
          className="input input-sm w-full"
          aria-label={t("account.pw.password")}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && void login()}
        />
      </fieldset>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void login()}>
          {busy && <span className="loading loading-spinner loading-xs" aria-hidden />}
          {t("account.pw.login")}
        </button>
        {err && (
          <span role="alert" className="text-xs text-error">
            {err}
          </span>
        )}
      </div>
    </div>
  );
}

export function LoginPanel({
  withPassword,
  onBaizhiLoggedIn,
  onMcLoggedIn,
}: {
  /** 是否提供 MonkeyCode 账号密码登录入口(已连 MonkeyCode、只补百智云
   *  登录的场景不给,免得引导用户重复登录) */
  withPassword: boolean;
  /** 百智云真实登录事件(短信/扫码成功各一次);宿主刷新状态并顺带桥接 */
  onBaizhiLoggedIn: () => void;
  /** MonkeyCode 账密登录成功;宿主刷新状态 */
  onMcLoggedIn: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"wechat" | "sms" | "password">("wechat");

  if (mode === "password") {
    return (
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-xs text-base-content/60">{t("account.pw.hint")}</p>
        <PasswordForm onLoggedIn={onMcLoggedIn} />
        <button
          type="button"
          className="btn btn-link btn-xs self-start px-0 font-normal text-base-content/50 no-underline hover:text-base-content"
          onClick={() => setMode("wechat")}
        >
          {t("account.pw.back")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex max-w-sm flex-col gap-1">
      <p className="text-xs text-base-content/60">{t("account.loginHint")}</p>
      <div role="tablist" className="tabs tabs-border">
        <button
          type="button"
          role="tab"
          className={mode === "wechat" ? "tab tab-active" : "tab"}
          aria-selected={mode === "wechat"}
          onClick={() => setMode("wechat")}
        >
          {t("account.tab.wechat")}
        </button>
        <button
          type="button"
          role="tab"
          className={mode === "sms" ? "tab tab-active" : "tab"}
          aria-selected={mode === "sms"}
          onClick={() => setMode("sms")}
        >
          {t("account.tab.sms")}
        </button>
      </div>
      {mode === "wechat" ? <WechatTab onLoggedIn={onBaizhiLoggedIn} /> : <SmsTab onLoggedIn={onBaizhiLoggedIn} />}
      {withPassword && (
        <button
          type="button"
          className="btn btn-link btn-xs self-start px-0 font-normal text-base-content/50 no-underline hover:text-base-content"
          onClick={() => setMode("password")}
        >
          {t("account.pw.entry")}
        </button>
      )}
    </div>
  );
}
