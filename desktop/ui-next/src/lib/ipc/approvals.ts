// 审批/提问的上行发送面。载荷形状 = 壳侧 driver/session.rs::session_send 的
// 接收端契约(以 Rust 侧为准,不按旧 UI 反推):
// - permission-resp:{ id, approved, remember, persist }。壳把 remember/persist
//   两档在新引擎(permissionRemember cap)下统一映射为引擎 respond.remember,
//   旧引擎回落壳侧工具名记忆集——UI 只负责如实上报动作档位;
// - reply-question:{ request_id, answers_json, cancelled }。answers_json 是
//   {问题: 答案} 的 JSON 字符串(多选为数组),壳回推 reply-question 回显帧。
import { inDesktopShell, invoke } from "./ipc";
import { sessionSend } from "./sessions";

/** 审批四动作:allow 仅本次;always 本会话始终;persist 此项目永久;deny 拒绝。 */
export type PermAction = "allow" | "always" | "persist" | "deny";

export function sendPermAnswer(sessionId: string, permId: string, action: PermAction): Promise<void> {
  return sessionSend(sessionId, "permission-resp", {
    id: permId,
    approved: action !== "deny",
    remember: action === "always" || action === "persist",
    persist: action === "persist",
  });
}

export function sendAskAnswers(
  sessionId: string,
  askId: string,
  answers: Record<string, string | string[]>,
): Promise<void> {
  return sessionSend(sessionId, "reply-question", {
    request_id: askId,
    answers_json: JSON.stringify(answers),
    cancelled: false,
  });
}

/** 跳过回答(cancelled=true):引擎收到取消,提问卡按无答案收口。 */
export function sendAskCancel(sessionId: string, askId: string): Promise<void> {
  return sessionSend(sessionId, "reply-question", {
    request_id: askId,
    answers_json: "{}",
    cancelled: true,
  });
}

/** 引擎能力表(对表壳侧 driver/mod.rs::Caps 的 serde 形状)。 */
export interface EngineCaps {
  browser_ext: boolean;
  usage_update: boolean;
  /** 审批记忆归引擎:false 时审批卡隐藏两个"始终"档 */
  perm_remember: boolean;
  attachments: boolean;
}

/** 能力快照;浏览器模式/引擎未起返回 null(调用方按默认档降级)。 */
export function engineCaps(): Promise<EngineCaps | null> {
  if (!inDesktopShell()) return Promise.resolve(null);
  return invoke<EngineCaps>("engine_caps").catch(() => null);
}
