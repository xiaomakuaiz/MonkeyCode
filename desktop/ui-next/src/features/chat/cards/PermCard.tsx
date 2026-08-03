// 审批卡与审批按钮行。按钮行(PermActions)同时供工具卡内嵌(锚定态)
// 复用——同一套动作词汇与乐观回写只维护一份,两处渲染不漂移。
// 答复后先本地乐观置态(按钮换成结果徽标),permission-resolved 帧随后
// 带权威 outcome 回写 ChatState(归约层已处理);发送失败回滚可重点。
import { useEffect, useState } from "react";

import { useI18n } from "@/lib/i18n";
import {
  engineCaps,
  localFrameSender,
  sendPermAnswerVia,
  type FrameSender,
  type PermAction,
} from "@/lib/ipc/approvals";
import { permStateLabel } from "@/lib/protocol/reduce";
import type { PermItem } from "@/lib/protocol/types";

/** 审批按钮行:允许/本会话始终/此项目永久/拒绝 + ⏎/esc 快捷键脚注。
 * engine_caps.perm_remember 为 false 时隐藏两个"始终"档。 */
export function PermActions({
  perm,
  sessionId,
  sendFrame,
}: {
  perm: PermItem;
  sessionId: string;
  /** 上行管道注入(云端任务经 stream WS);缺省 = sessionId 的本地 sender */
  sendFrame?: FrameSender;
}) {
  const { t } = useI18n();
  const [local, setLocal] = useState<"allowed" | "rejected" | null>(null);
  const [canRemember, setCanRemember] = useState(true);
  useEffect(() => {
    let alive = true;
    void engineCaps().then((caps) => {
      if (alive && caps) setCanRemember(caps.perm_remember);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (local) {
    return <span className="badge badge-ghost badge-sm self-start">{permStateLabel(local)}</span>;
  }

  const answer = (action: PermAction) => {
    setLocal(action === "deny" ? "rejected" : "allowed");
    void sendPermAnswerVia(sendFrame ?? localFrameSender(sessionId), perm.id, action).catch(() => setLocal(null)); // 未送达回滚,按钮恢复可点
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-primary btn-xs" onClick={() => answer("allow")}>
        {t("chat.perm.allow")}
      </button>
      {canRemember && (
        <>
          <button type="button" className="btn btn-xs" onClick={() => answer("always")}>
            {t("chat.perm.always")}
          </button>
          <button type="button" className="btn btn-xs" onClick={() => answer("persist")}>
            {t("chat.perm.persist")}
          </button>
        </>
      )}
      <button type="button" className="btn btn-outline btn-error btn-xs" onClick={() => answer("deny")}>
        {t("chat.perm.deny")}
      </button>
      <span className="ms-auto flex items-center gap-1 text-[11px] text-base-content/50">
        <kbd className="kbd kbd-xs">⏎</kbd>
        {t("chat.perm.allow")}
        <span aria-hidden> · </span>
        <kbd className="kbd kbd-xs">esc</kbd>
        {t("chat.perm.deny")}
      </span>
    </div>
  );
}

/** 独立审批卡(无锚点/找不到同 id 工具卡时渲染):警示框 + mono 原文 +
 * 按钮行;已决/过期收成一行状态(回放的审计痕迹)。 */
export function PermCard({
  item,
  sessionId,
  sendFrame,
}: {
  item: PermItem;
  sessionId: string;
  sendFrame?: FrameSender;
}) {
  const { t } = useI18n();
  if (item.state !== "open") {
    return (
      <div role="status" className="alert alert-soft py-1.5 text-xs" data-perm-id={item.id}>
        <span className="min-w-0 flex-1 truncate">
          {t("chat.permission")}:{item.title}
        </span>
        <span className="badge badge-ghost badge-xs">{permStateLabel(item.state)}</span>
      </div>
    );
  }
  return (
    <div role="alert" className="card card-border border-warning/50 bg-warning/5" data-perm-id={item.id}>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-warning">
          <span aria-hidden>⏸</span>
          <span>{t("chat.perm.needConfirm")}</span>
          {item.tool && <span className="badge badge-warning badge-soft badge-xs font-mono">{item.tool}</span>}
        </div>
        <div className="rounded-box bg-base-200 px-3 py-2 font-mono text-xs break-all select-text">{item.title}</div>
        <PermActions perm={item} sessionId={sessionId} sendFrame={sendFrame} />
      </div>
    </div>
  );
}
