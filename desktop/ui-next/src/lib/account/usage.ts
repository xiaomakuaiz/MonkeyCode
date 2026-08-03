// MonkeyCode 账号权益的展示口径(纯派生层,渲染在 features/account 的用量
// 面板)。口径与移动端 profile 页对齐:等级归一、token 缩写、今日额度、
// 签到与邀请。文案不在这里拼——面板按 i18n 键组装,本层只出结构化数值。
import type { McUsage } from "@/lib/ipc/account";

/** 签到/邀请奖励数额:服务端不下发,各端硬编码同源(改版要一起改)。 */
export const CHECKIN_REWARD = 100;
export const INVITE_REWARD = 5000;

/** 会员档(归一后)。flagship 是 ultra 的服务端别名。 */
export type PlanTier = "basic" | "pro" | "ultra";

export function planTier(plan?: string): PlanTier {
  if (plan === "ultra" || plan === "flagship") return "ultra";
  if (plan === "pro") return "pro";
  return "basic";
}

/** token 数缩写:百万以上取一位小数的 M,否则千分位。 */
export function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(Math.floor(v / 100_000) / 10).toFixed(1)}M`;
  return v.toLocaleString("en-US");
}

/** 面板要渲染的一切;null = 无可展示内容(整块不占位)。 */
export interface UsageVM {
  plan: PlanTier;
  /** 是否有订阅信息(没有则会员行不出现) */
  hasSubscription: boolean;
  /** 付费档到期日(yyyy-mm-dd);null = 长期有效/基础档(到期日无意义) */
  expiresAt: string | null;
  /** 积分余额(已 /1000 千分位);钱包缺席 null */
  credits: string | null;
  /** 今日免费模型额度;钱包缺席 null。total 为 0 = 无额度档位 */
  quota: { total: number; remaining: number; ratio: number; remainingText: string; totalText: string } | null;
  /** 当天是否已签到;null = 没取到,签到入口整个不出现(不催、不误报) */
  checkedIn: boolean | null;
  /** 邀请概况;端点缺席 null。link 拼不出(缺基址或账号 id)为空串 */
  invite: { count: number; link: string } | null;
}

const clamp = (v: number, total: number) => Math.min(Math.max(v, 0), total);

/** userId 来自 mc_status 的云端账号,用于拼邀请链接;缺失时 link 为空串。 */
export function usageVM(usage: McUsage | null | undefined, userId?: string): UsageVM | null {
  if (!usage) return null;
  const { wallet, subscription, invitations } = usage;
  const checkedIn = usage.checked_in ?? null;
  if (!wallet && !subscription && !invitations && checkedIn === null) return null;

  const plan = planTier(subscription?.plan);
  // 到期日只对付费档有意义:基础档服务端不给 expires_at,给了也不代表会降级
  const expiresAt = plan !== "basic" && subscription?.expires_at ? subscription.expires_at.slice(0, 10) : null;

  let credits: string | null = null;
  let quota: UsageVM["quota"] = null;
  if (wallet) {
    credits = Math.floor((wallet.balance ?? 0) / 1000).toLocaleString("en-US");
    const total = Math.max(wallet.daily_token_limit ?? 0, 0);
    // 上限为 0 = 该账号没有免费额度档位,余额字段不具备「剩余/总量」语义
    const remaining =
      total > 0 ? clamp(wallet.daily_token_balance ?? 0, total) : Math.max(wallet.daily_token_balance ?? 0, 0);
    quota = {
      total,
      remaining,
      ratio: total > 0 ? remaining / total : 0,
      remainingText: fmtTokens(remaining),
      totalText: fmtTokens(total),
    };
  }

  const base = (usage.base_url || "").replace(/\/+$/, "");
  const invite = invitations
    ? {
        count: invitations.count ?? invitations.items?.length ?? 0,
        // 与移动端同款邀请链接;基址或账号 id 缺一不可,拼不出就不给入口
        link: base && userId ? `${base}/?ic=${userId}` : "",
      }
    : null;

  return { plan, hasSubscription: !!subscription, expiresAt, credits, quota, checkedIn, invite };
}
