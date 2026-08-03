// MonkeyCode 账号权益面板:会员档 badge/有效期、今日额度 progress、积分、
// 签到按钮三态(可签/签到中/已签)、邀请概况。数据在挂载时自取一次
// (mc_usage 四路并发在壳侧收口),不进任何全局轮询——面板只在设置页
// 可见,常驻轮询等于为看不见的面板空跑请求。
import { useCallback, useEffect, useState } from "react";

import { CHECKIN_REWARD, usageVM } from "@/lib/account/usage";
import { useI18n } from "@/lib/i18n";
import { mcCheckin, mcUsage, type McUsage } from "@/lib/ipc/account";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function UsagePanel({ userId }: { userId?: string }) {
  const { t } = useI18n();
  const [usage, setUsage] = useState<McUsage | null>(null);
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [checkinErr, setCheckinErr] = useState("");

  const load = useCallback(async () => {
    // 全失败(会话失效/私有化部署无权益端点)就当没有权益可展示,
    // 面板整块不出现——没有比「不显示」更有用的降级
    setUsage(await mcUsage().catch(() => null));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const vm = usageVM(usage, userId);
  if (!vm) return null;

  const checkin = async () => {
    setCheckinBusy(true);
    setCheckinErr("");
    try {
      await mcCheckin();
      // 成功后重拉权益:+积分 与「今日已签到」一次刷出
      await load();
    } catch (e) {
      // 重复签到等属业务提示,就地展示,不升级为连接错误
      setCheckinErr(errMsg(e));
    } finally {
      setCheckinBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" aria-label={t("account.usage.label")}>
      {vm.hasSubscription && (
        <div className="flex items-center gap-2">
          <span className={vm.plan === "basic" ? "badge badge-ghost badge-sm" : "badge badge-primary badge-sm"}>
            {t(`account.usage.plan.${vm.plan}`)}
          </span>
          <span className="text-xs text-base-content/60">
            {vm.expiresAt ? t("account.usage.expiry", { date: vm.expiresAt }) : t("account.usage.noExpiry")}
          </span>
        </div>
      )}
      {vm.quota && (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-semibold">{t("account.usage.quota")}</span>
            <span className="text-xs text-base-content/60">
              {vm.quota.total > 0
                ? t("account.usage.quotaText", { remaining: vm.quota.remainingText, total: vm.quota.totalText })
                : t("account.usage.quotaNone")}
            </span>
          </div>
          {vm.quota.total > 0 && (
            <progress
              className="progress progress-primary w-full"
              aria-label={t("account.usage.quota")}
              value={vm.quota.remaining}
              max={vm.quota.total}
            />
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {vm.credits !== null && (
          <span className="text-xs text-base-content/70">{t("account.usage.credits", { credits: vm.credits })}</span>
        )}
        {/* 签到三态:可签/签到中/已签;checkedIn 没取到时按钮整个不出现 */}
        {vm.checkedIn !== null && (
          <button
            type="button"
            className="btn btn-outline btn-xs"
            disabled={checkinBusy || vm.checkedIn}
            onClick={() => void checkin()}
          >
            {checkinBusy && <span className="loading loading-spinner loading-xs" aria-hidden />}
            {checkinBusy
              ? t("account.usage.checkinBusy")
              : vm.checkedIn
                ? t("account.usage.checkedIn")
                : t("account.usage.checkin", { reward: CHECKIN_REWARD })}
          </button>
        )}
        {checkinErr && (
          <span role="alert" className="text-xs text-error">
            {checkinErr}
          </span>
        )}
      </div>
      {vm.invite && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-base-content/60">
          <span>{t("account.usage.invite", { count: vm.invite.count })}</span>
          {vm.invite.link && (
            <span className="font-mono select-all" title={t("account.usage.inviteLink")}>
              {vm.invite.link}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
