// 帧 → 对话流渲染项的归约:流式文本聚合、工具状态回写、审批卡片终态等。
// 纯函数,不触 DOM。
import { frameData } from "./client";
import { b64decode } from "./client";
import type { AcpUpdate, Frame, LogItem, PermOutcome, SubItem, ToolProgress, Usage } from "./types";

export interface ChatState {
  items: LogItem[];
  running: boolean;
  usage: Usage | null;
  /** 流式聚合目标:'agent' | 'thought' | ''(断流) */
  streamKind: string;
  /** 本轮结束时需要刷新改动计数 */
  turnEnded: boolean;
  /** 会话当前模型(model_update 帧回写;空 = 以会话 meta 为准) */
  model: string;
  /** 会话权限模式(permission_mode_update 帧回写;空 = 以会话 meta 为准) */
  permMode: string;
}

export const initialChat: ChatState = {
  items: [],
  running: false,
  usage: null,
  streamKind: "",
  turnEnded: false,
  model: "",
  permMode: "",
};

const PERM_OUTCOME: Record<PermOutcome, string> = {
  approved: "已允许",
  denied: "已拒绝",
  timeout: "已超时(按拒绝处理)",
  cancelled: "已取消",
};

export function permStateLabel(state: string): string {
  switch (state) {
    case "allowed":
      return "已允许";
    case "rejected":
      return "已拒绝";
    case "expired":
      return "(已过期)";
    default:
      return PERM_OUTCOME[state as PermOutcome] ?? state;
  }
}

/** 追加流式文本:与上一项同 kind 则合并,否则新开一项 */
function appendStream(s: ChatState, kind: "agent" | "thought", text: string): ChatState {
  const items = s.items.slice();
  const last = items[items.length - 1];
  if (s.streamKind === kind && last && last.kind === kind) {
    items[items.length - 1] = { ...last, text: last.text + text };
  } else {
    items.push({ kind, text });
  }
  return { ...s, items, streamKind: kind };
}

function push(s: ChatState, item: LogItem): ChatState {
  return { ...s, items: [...s.items, item], streamKind: "" };
}

/** 轮次结束:未答复的审批卡片过期 */
function expirePerms(items: LogItem[]): LogItem[] {
  return items.map((it) => (it.kind === "perm" && it.state === "open" ? { ...it, state: "expired" } : it));
}

/** 执行期进度:更新对应工具项的子步骤/输出行/子会话引用 */
function applyProgress(s: ChatState, tcId: string, p: ToolProgress): ChatState {
  const items = s.items.slice();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== "tool" || it.tcId !== tcId) continue;
    switch (p.kind) {
      case "subagent_tool": {
        const subItems = (it.subItems ?? []).slice();
        const idx = subItems.findIndex((x) => x.id === p.id);
        const entry: SubItem = {
          id: p.id ?? String(subItems.length),
          title: p.title ?? "",
          status: (p.status as SubItem["status"]) ?? "run",
        };
        if (idx >= 0) subItems[idx] = { ...entry, title: entry.title || subItems[idx].title };
        else subItems.push(entry);
        items[i] = { ...it, subItems };
        break;
      }
      case "output":
        items[i] = { ...it, lastLine: p.line };
        break;
      case "child_session":
        items[i] = { ...it, childSessionId: p.childSessionId };
        break;
    }
    return { ...s, items };
  }
  return s;
}

function reduceAcp(s: ChatState, u: AcpUpdate): ChatState {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return appendStream(s, "agent", u.content?.text ?? "");
    case "agent_thought_chunk":
      return appendStream(s, "thought", u.content?.text ?? "");
    case "tool_call":
      return push(s, {
        kind: "tool",
        tcId: u.toolCallId ?? "",
        title: u.title || u.kind || "工具调用",
        status: "run",
        out: "",
      });
    case "tool_call_update": {
      if (u.status === "in_progress") {
        return u.progress ? applyProgress(s, u.toolCallId ?? "", u.progress) : s;
      }
      const items = s.items.slice();
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "tool" && it.tcId === u.toolCallId) {
          const out = typeof u.rawOutput === "string" ? u.rawOutput.split("\n")[0].slice(0, 160) : "";
          items[i] = { ...it, status: u.status === "completed" ? "ok" : "fail", out, lastLine: undefined };
          break;
        }
      }
      return { ...s, items };
    }
    case "plan": {
      // 更新最近的计划卡片而非无限追加;没有则新建
      const items = s.items.slice();
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === "plan") {
          items[i] = { kind: "plan", entries: u.entries ?? [] };
          return { ...s, items, streamKind: "" };
        }
      }
      return push(s, { kind: "plan", entries: u.entries ?? [] });
    }
    case "llm_call_retry":
      return push(s, { kind: "sys", text: `模型调用重试 #${u.attempt ?? "?"}: ${u.message ?? ""}` });
    case "usage_update":
      return { ...s, usage: { used: u.used ?? 0, size: u.size ?? 0 } };
    case "compact_status":
      return push(s, {
        kind: "sys",
        text: u.status === "started" ? "⟳ 上下文接近上限,正在压缩…" : "⟳ 上下文压缩完成",
      });
    case "model_update": {
      const name = u.model ?? "";
      return { ...push(s, { kind: "sys", text: `模型已切换为 ${name}` }), model: name };
    }
    case "permission_mode_update": {
      const mode = u.mode ?? "default";
      const text =
        mode === "yolo" ? "⚡ 已开启 YOLO 模式:所有操作不再询问,直接执行" : "已恢复默认权限模式";
      return { ...push(s, { kind: "sys", text }), permMode: mode };
    }
    default:
      return s;
  }
}

export function reduceFrame(s: ChatState, f: Frame): ChatState {
  switch (f.type) {
    case "task-started":
      return { ...s, running: true };
    case "task-ended":
      return {
        ...s,
        running: false,
        streamKind: "",
        turnEnded: true,
        items: [...expirePerms(s.items), { kind: "sys", text: "— 本轮结束 —" }],
      };
    case "task-error": {
      const data = frameData<{ error?: string }>(f);
      return {
        ...s,
        running: false,
        streamKind: "",
        items: [...expirePerms(s.items), { kind: "sys", text: "✗ " + (data?.error || "未知错误"), error: true }],
      };
    }
    case "user-input": {
      const data = frameData<{ content?: string }>(f);
      let text = "";
      try {
        text = data?.content ? b64decode(data.content) : "";
      } catch {
        text = data?.content ?? "";
      }
      return push(s, { kind: "user", text });
    }
    case "permission-req": {
      const data = frameData<{ id?: string; title?: string; tool?: string }>(f);
      if (!data?.id) return s;
      return push(s, { kind: "perm", id: data.id, title: data.title ?? "", tool: data.tool ?? "", state: "open" });
    }
    case "permission-resolved": {
      const data = frameData<{ id?: string; outcome?: string }>(f);
      if (!data?.id) return s;
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === "perm" && it.id === data.id && it.state === "open"
            ? { ...it, state: (data.outcome as PermOutcome) ?? "expired" }
            : it,
        ),
      };
    }
    case "task-running":
      if (f.kind === "acp_event") {
        const data = frameData<{ update?: AcpUpdate }>(f);
        if (data?.update) return reduceAcp(s, data.update);
      }
      return s;
    default:
      return s;
  }
}

export function reduceBatch(s: ChatState, batch: Frame[]): ChatState {
  let next = s;
  for (const f of batch) next = reduceFrame(next, f);
  return next;
}

/** 本地答复审批卡片(点击按钮后立即回写 UI,不等 resolved 帧) */
export function answerPerm(s: ChatState, id: string, approved: boolean): ChatState {
  return {
    ...s,
    items: s.items.map((it) =>
      it.kind === "perm" && it.id === id && it.state === "open"
        ? { ...it, state: approved ? "allowed" : "rejected" }
        : it,
    ),
  };
}
