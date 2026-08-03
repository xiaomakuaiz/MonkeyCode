// 全局键盘审批:⏎ 允许 / esc 拒绝。判定是纯函数(resolveShortcut),
// 不触 DOM——允许/拒绝都是不可逆动作,守卫必须可被表驱动测试钉死;
// useApprovalHotkeys 只是把 DOM 读取(事件目标/草稿内容)喂给判定的薄壳。
import { useEffect, useRef } from "react";

import { sendPermAnswer } from "@/lib/ipc/approvals";
import type { ChatState } from "@/lib/protocol/types";

export interface ShortcutCtx {
  key: string;
  /** IME 组合中:⏎/esc 属于候选词交互,不能当审批应答 */
  isComposing?: boolean;
  /** 事件目标标签名(大写;无目标 undefined) */
  targetTag?: string;
  /** 目标输入框里已有的内容(⏎ 不抢正在写的消息) */
  inputText?: string;
  /** 最近一张待答复审批卡 id(无则 null) */
  openPermId: string | null;
}

export type ShortcutAction =
  /** 不消费:esc 交由上层浮层链/默认行为 */
  | { kind: "none" }
  /** 输入态 esc 只收敛焦点(尤其不能当审批拒绝——deny 不可逆) */
  | { kind: "blur" }
  | { kind: "perm"; id: string; approved: boolean };

const NONE: ShortcutAction = { kind: "none" };

/** esc 的输入态含 SELECT(下拉展开时 esc 归下拉);⏎ 靠"草稿非空"守卫,
 * 原生 select 无草稿概念,空草稿的 ⏎ 照常应答审批。 */
const TYPING_TAGS = new Set(["TEXTAREA", "INPUT", "SELECT"]);

export function resolveShortcut(ctx: ShortcutCtx): ShortcutAction {
  if (ctx.isComposing) return NONE;
  const typing = TYPING_TAGS.has(ctx.targetTag ?? "");
  if (ctx.key === "Enter") {
    if (!ctx.openPermId) return NONE;
    if (typing && (ctx.inputText ?? "").trim()) return NONE; // 正在写消息,不劫持
    return { kind: "perm", id: ctx.openPermId, approved: true };
  }
  if (ctx.key === "Escape") {
    if (typing) return { kind: "blur" };
    if (ctx.openPermId) return { kind: "perm", id: ctx.openPermId, approved: false };
    return NONE;
  }
  return NONE;
}

/** 从对话流尾部找最近一张待答复审批卡(键盘应答的目标)。 */
export function openPermIdOf(state: ChatState): string | null {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i];
    if (it && it.kind === "perm" && it.state === "open") return it.id;
  }
  return null;
}

/** 挂 window keydown 的薄 hook:仅在有待决审批时监听;同一张卡只发一次
 * (permission-resolved 帧回来前连按不重发),发送失败解除标记可重按。 */
export function useApprovalHotkeys(state: ChatState, sessionId: string): void {
  const openPermId = openPermIdOf(state);
  const answeredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!openPermId) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const inputText =
        target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement ? target.value : "";
      const action = resolveShortcut({
        key: e.key,
        isComposing: e.isComposing,
        targetTag: target?.tagName,
        inputText,
        openPermId,
      });
      if (action.kind === "blur") {
        target?.blur();
        return;
      }
      if (action.kind !== "perm" || answeredRef.current.has(action.id)) return;
      e.preventDefault();
      answeredRef.current.add(action.id);
      void sendPermAnswer(sessionId, action.id, action.approved ? "allow" : "deny").catch(() => {
        answeredRef.current.delete(action.id);
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPermId, sessionId]);
}
