// 帧 → 对话流渲染项的归约:流式文本聚合、工具卡生命周期、审批/提问状态机、
// 会话态回写(usage/model/think/permission_mode)、seq 去重与前插历史。
// 纯函数、不可变更新,不触 DOM;壳连接层与云端连接层喂帧,视图只读状态。
import { decodeUserInput, frameData, toolContentText, toolResultText } from "./codec";
import type {
  AcpUpdate,
  AskItem,
  AskQuestion,
  ChatAttachment,
  ChatItem,
  ChatState,
  Frame,
  PermItem,
  PermOutcome,
  ToolItem,
  ToolProgress,
  ToolStatus,
} from "./types";

export function createChatState(): ChatState {
  return {
    items: [],
    running: false,
    usage: null,
    plan: [],
    streamKind: "",
    turnEnded: false,
    model: "",
    think: "",
    permMode: "",
    commands: [],
    keyBase: 0,
    lastSeq: 0,
  };
}

// ==================== 展示文案(状态词 → 中文) ====================

/** 思考档位展示名(""=跟随模型默认;composer 的档位选择器同源)。 */
export const THINK_LABELS: Record<string, string> = {
  "": "默认",
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
};

const PERM_OUTCOME_LABELS: Record<PermOutcome, string> = {
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
      return PERM_OUTCOME_LABELS[state as PermOutcome] ?? state;
  }
}

// ==================== 私有小工具 ====================

type UnknownRecord = Record<string, unknown>;

function unknownRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

/** 云端 _meta 会分多帧补齐,递归合并——后一个状态帧不能擦掉前面的 diff 信息。 */
function mergeUnknown(previous: unknown, next: unknown): unknown {
  if (next === undefined) return previous;
  const left = unknownRecord(previous);
  const right = unknownRecord(next);
  if (!left || !right) return next;
  const merged: UnknownRecord = { ...left };
  for (const [key, value] of Object.entries(right)) merged[key] = mergeUnknown(left[key], value);
  return merged;
}

/** 从尾部找同 tcId 的工具卡(同 id 重开时最后一张是现役)。 */
function lastToolIndex(items: readonly ChatItem[], tcId: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it && it.kind === "tool" && it.tcId === tcId) return i;
  }
  return -1;
}

/** 追加流式文本:streamKind 未断且末项同类则并入,否则新开一项。
 * timestamp 只记在 agent 项的首个分片上(正文气泡显示消息时间)。 */
function appendStream(s: ChatState, kind: "agent" | "thought", text: string, timestamp?: number): ChatState {
  const items = s.items.slice();
  const last = items.at(-1);
  if (s.streamKind === kind && last && last.kind === kind) {
    items[items.length - 1] = { ...last, text: last.text + text };
  } else {
    items.push({ kind, text, ...(kind === "agent" && timestamp !== undefined ? { timestamp } : {}) });
  }
  return { ...s, items, streamKind: kind };
}

/** 追加非流式项并断流(下一个文本分片必须新开气泡,不得并进旧项)。 */
function pushItem(s: ChatState, item: ChatItem): ChatState {
  return { ...s, items: [...s.items, item], streamKind: "" };
}

/** 轮次结束/出错:未答复的审批卡与提问卡过期(按钮不再可点)。 */
function expireOpenAsks(items: ChatItem[]): ChatItem[] {
  return items.map((it) =>
    (it.kind === "perm" || it.kind === "ask") && it.state === "open" ? { ...it, state: "expired" } : it,
  );
}

// ==================== 工具卡生命周期 ====================

const TERMINAL_TOOL_STATUS = new Set(["completed", "failed", "error", "cancelled"]);

function isTerminal(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_TOOL_STATUS.has(status);
}

/** 用 update 里"有值"的字段覆写卡片,缺席字段保留旧值;_meta 递归合并。 */
function mergeToolUpdate(item: ToolItem, u: AcpUpdate): ToolItem {
  return {
    ...item,
    ...(u.title ? { title: u.title } : {}),
    ...(u.kind !== undefined ? { toolKind: u.kind } : {}),
    ...(u.rawInput !== undefined ? { rawInput: u.rawInput } : {}),
    ...(u.rawOutput !== undefined ? { rawOutput: u.rawOutput } : {}),
    ...(u.content !== undefined ? { content: u.content } : {}),
    ...(u.locations !== undefined ? { locations: u.locations } : {}),
    ...(u._meta !== undefined ? { _meta: mergeUnknown(item._meta, u._meta) } : {}),
    ...(Array.isArray(u.images) ? { images: u.images } : {}),
  };
}

/** 非终态 update 只回写详情字段;找不到卡片原样返回(容忍乱序/缺帧)。 */
function mergeToolInState(s: ChatState, tcId: string, u: AcpUpdate): ChatState {
  const idx = lastToolIndex(s.items, tcId);
  const prev = idx >= 0 ? s.items[idx] : undefined;
  if (!prev || prev.kind !== "tool") return s;
  const items = s.items.slice();
  items[idx] = mergeToolUpdate(prev, u);
  return { ...s, items };
}

/** 进度窗口在内存里保留的条数上限(渲染只取尾部几条,完整过程在子会话)。 */
const MAX_FEED = 200;

/** 执行期进度:更新对应工具卡的进度窗口/输出行/子会话引用。 */
function applyProgress(s: ChatState, tcId: string, p: ToolProgress): ChatState {
  const idx = lastToolIndex(s.items, tcId);
  const prev = idx >= 0 ? s.items[idx] : undefined;
  if (!prev || prev.kind !== "tool") return s;

  let patched: ToolItem;
  switch (p.kind) {
    case "subagent_tool": {
      let feed = (prev.feed ?? []).slice();
      const at = feed.findIndex((x) => x.kind === "tool" && x.id === p.id);
      const existing = at >= 0 ? feed[at] : undefined;
      const status: ToolStatus = (p.status as ToolStatus | undefined) ?? "run";
      if (existing && existing.kind === "tool") {
        // 原地更新:标题/入参缺省保留旧值(状态帧常只带 status)
        const rawInput = p.rawInput !== undefined ? p.rawInput : existing.rawInput;
        feed[at] = {
          kind: "tool",
          id: existing.id,
          title: p.title || existing.title,
          ...(rawInput !== undefined ? { rawInput } : {}),
          status,
        };
      } else {
        feed.push({
          kind: "tool",
          id: p.id ?? String(feed.length),
          title: p.title ?? "",
          ...(p.rawInput !== undefined ? { rawInput: p.rawInput } : {}),
          status,
        });
        if (feed.length > MAX_FEED) feed = feed.slice(-MAX_FEED);
      }
      patched = { ...prev, feed };
      break;
    }
    case "subagent_text": {
      if (!p.line) return s;
      let feed = (prev.feed ?? []).slice();
      feed.push({ kind: "text", text: p.line });
      if (feed.length > MAX_FEED) feed = feed.slice(-MAX_FEED);
      patched = { ...prev, feed };
      break;
    }
    case "output":
      patched = { ...prev, lastLine: p.line };
      break;
    case "child_session":
      patched = { ...prev, childSessionId: p.childSessionId };
      break;
    default:
      return s;
  }
  const items = s.items.slice();
  items[idx] = patched;
  return { ...s, items };
}

/** 终态回写。终态可重复到达:后台 Agent 卡的真实结果随 task_notification
 * 迟到,驱动补发终态帧回填——后到者权威,直接覆写。 */
function closeTool(s: ChatState, u: AcpUpdate, timestamp: number | undefined): ChatState {
  const idx = lastToolIndex(s.items, u.toolCallId ?? "");
  const prev = idx >= 0 ? s.items[idx] : undefined;
  if (!prev || prev.kind !== "tool") return s;

  const merged = mergeToolUpdate(prev, u);
  const raw = toolResultText(merged.rawOutput, merged.content);
  const failed = u.status !== "completed";
  // 耗时只算一次(首个带起止时间的终态),后台回填的重复终态不重算
  const durationMs =
    prev.durationMs ??
    (timestamp !== undefined && prev.startedAt !== undefined && timestamp >= prev.startedAt
      ? timestamp - prev.startedAt
      : undefined);
  const timing = durationMs !== undefined ? { durationMs } : {};
  const items = s.items.slice();

  if (raw.includes("子代理已转入后台继续执行")) {
    // Agent 工具"转后台"的 completed 只是启动回执:卡片视觉上保持运行态,
    // 进度直播照常,真正的终态由后续补发帧回填
    items[idx] = { ...merged, status: "run", out: "后台运行中", result: undefined, lastLine: undefined, background: true };
    return { ...s, items };
  }
  if (prev.background) {
    // 后台卡的迟到终态:收起卡片,完整正文只留在卡数据里(卡自己展示),
    // 并标记吞掉紧随其后的重复 task_notification
    items[idx] = {
      ...merged,
      status: failed ? "fail" : "ok",
      out: failed ? "后台执行失败" : "后台执行完成",
      result: raw,
      ...timing,
      lastLine: undefined,
      backgroundNoticePending: true,
    };
    return { ...s, items, streamKind: "" };
  }
  // 完整结果一并保留:子代理卡把最终产出按 markdown 展示,
  // 普通工具卡仅在失败时外显首行摘要
  const out = (raw.split("\n")[0] ?? "").slice(0, 160);
  items[idx] = { ...merged, status: failed ? "fail" : "ok", out, result: raw, ...timing, lastLine: undefined };
  return { ...s, items };
}

// ==================== AI 提问(ask_user_question,对齐 mobile handler.ts) ====================

/** 问题结构归一:multiple/multiSelect 兼容,options 只留 label/description。 */
function normalizeAskQuestions(raw: unknown, defaultMultiple: boolean): AskQuestion[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((q) => {
    const o = q as {
      question?: string;
      header?: string;
      multiple?: boolean;
      multiSelect?: boolean;
      custom?: boolean;
      options?: { label?: string; description?: string }[];
    } | null;
    return {
      question: o?.question ?? "",
      header: o?.header,
      multiSelect: !!(o?.multiple ?? o?.multiSelect ?? defaultMultiple),
      // 自定义答案默认开启:引擎(ohmyagent)对答复零校验,任意文本都接受,
      // 且 UserQuestion schema 根本没有 custom 字段(它只是 UserAnswer 的
      // 回传标记)——按 !!custom 判定入口永远不亮;显式 false 才关闭
      custom: o?.custom !== false,
      options: (Array.isArray(o?.options) ? o.options : []).map((x) => ({
        label: x?.label ?? "",
        description: x?.description,
      })),
    };
  });
}

/** 从 tool_call/acp_ask_user_question 载荷提取问题清单(rawInput 优先,_meta 兜底)。 */
function askQuestionsFrom(tc: AcpUpdate | Record<string, unknown>): AskQuestion[] | null {
  const t = tc as {
    rawInput?: { questions?: unknown; multiple?: boolean };
    _meta?: { askUserQuestion?: { questions?: unknown; multiple?: boolean } };
  };
  const meta = t._meta?.askUserQuestion;
  const raw = Array.isArray(t.rawInput?.questions) ? t.rawInput.questions : meta?.questions;
  const defMulti = !!(t.rawInput?.multiple ?? meta?.multiple ?? false);
  return normalizeAskQuestions(raw, defMulti);
}

/** 该 tool_call 是否是"向用户提问"(title/kind 词汇 + 载荷里确有问题清单)。 */
function isAskToolCall(u: AcpUpdate): AskQuestion[] | null {
  const questions = askQuestionsFrom(u);
  if (!questions) return null;
  const norm = (v?: string) => (v ?? "").toLowerCase().trim().replace(/[_\s]+/g, "-");
  const title = norm(u.title);
  const kind = norm(u.kind);
  const hit =
    title === "question" ||
    title === "user-question" ||
    title.endsWith("-user-question") ||
    title.includes("ask-user-question") ||
    kind === "user-question" ||
    kind === "ask-user-question" ||
    (title === "" && kind === "");
  return hit ? questions : null;
}

/** 新建/更新提问卡:同 askId 原地更新(保留已答内容);占位工具卡原地替换。 */
function upsertAsk(s: ChatState, askId: string, questions: AskQuestion[], completed: boolean): ChatState {
  const items = s.items.slice();
  const askIdx = items.findIndex((it) => it.kind === "ask" && it.askId === askId);
  const existing = askIdx >= 0 ? items[askIdx] : undefined;
  if (existing && existing.kind === "ask") {
    // 重发的问题清单可能更全,但已答内容按题干保留(done 态不回退)
    const answered = new Map(
      existing.questions.filter((q) => q.answer !== undefined).map((q) => [q.question, q.answer] as const),
    );
    items[askIdx] = {
      ...existing,
      state: existing.state === "done" ? "done" : completed ? "done" : existing.state,
      questions: questions.map((q) => (answered.has(q.question) ? { ...q, answer: answered.get(q.question) } : q)),
    };
    return { ...s, items, streamKind: "" };
  }
  const next: AskItem = { kind: "ask", askId, state: completed ? "done" : "open", questions };
  // 同 id 已出过普通工具卡(词汇判定迟到):原地替换,不重复出卡
  const toolIdx = items.findIndex((it) => it.kind === "tool" && it.tcId === askId);
  if (toolIdx >= 0) {
    items[toolIdx] = next;
    return { ...s, items, streamKind: "" };
  }
  items.push(next);
  return { ...s, items, streamKind: "" };
}

// ==================== 模型名展示(model_update 系统行) ====================

/** 剥会员档位前缀(monkeycode-xxx/)得短名;剥空回落原名。 */
function stripTierPrefix(name: string): string {
  return name.replace(/^monkeycode-[^/]+\//i, "") || name;
}

/** 剥同步条目落盘名的来源后缀(@baizhi|@monkeycode,会员条目还带
 * #<服务端配置 id>)。它只是引擎寻址键的一部分,任何展示面都必须剥;
 * 壳侧 driver/session.rs strip_source_suffix 同口径,两处必须一致。 */
function stripSourceSuffix(name: string): string {
  return name.replace(/@(?:baizhi|monkeycode)(?:#.*)?$/i, "") || name;
}

// ==================== ACP sessionUpdate 归约 ====================

function reduceAcp(s: ChatState, u: AcpUpdate, timestamp?: number): ChatState {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return appendStream(s, "agent", toolContentText(u.content), timestamp);
    case "agent_thought_chunk":
      return appendStream(s, "thought", toolContentText(u.content));
    case "tool_call": {
      // 云端 CLI 的"向用户提问"以 tool_call 形态出现,渲染为提问卡而非工具卡
      const askQs = isAskToolCall(u);
      if (askQs && u.toolCallId) return upsertAsk(s, u.toolCallId, askQs, u.status === "completed");
      const next = pushItem(s, {
        kind: "tool",
        tcId: u.toolCallId ?? "",
        title: u.title || u.kind || "工具调用",
        ...(u.kind !== undefined ? { toolKind: u.kind } : {}),
        ...(u.rawInput !== undefined ? { rawInput: u.rawInput } : {}),
        ...(u.rawOutput !== undefined ? { rawOutput: u.rawOutput } : {}),
        ...(u.content !== undefined ? { content: u.content } : {}),
        ...(u.locations !== undefined ? { locations: u.locations } : {}),
        ...(u._meta !== undefined ? { _meta: u._meta } : {}),
        ...(Array.isArray(u.images) ? { images: u.images } : {}),
        ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
        status: "run",
        out: "",
      });
      // 部分云端历史把完整终态直接放在 tool_call,而不再单独补 update
      if (isTerminal(u.status)) return closeTool(next, u, undefined);
      return u.progress ? applyProgress(next, u.toolCallId ?? "", u.progress) : next;
    }
    case "tool_call_update": {
      const askQs = isAskToolCall(u);
      if (askQs && u.toolCallId) return upsertAsk(s, u.toolCallId, askQs, u.status === "completed");
      // 已是提问卡的 toolCallId 只回写终态(completed → done)
      if (u.toolCallId && s.items.some((it) => it.kind === "ask" && it.askId === u.toolCallId)) {
        if (u.status !== "completed") return s;
        return {
          ...s,
          items: s.items.map((it) =>
            it.kind === "ask" && it.askId === u.toolCallId && it.state === "open" ? { ...it, state: "done" } : it,
          ),
        };
      }
      if (!isTerminal(u.status)) {
        // 注:已闭合卡也接受 progress——显式转后台的 Agent 卡先以
        // "已转入后台"文案 completed,后台代理继续流式,进度窗照常直播
        const merged = mergeToolInState(s, u.toolCallId ?? "", u);
        return u.progress ? applyProgress(merged, u.toolCallId ?? "", u.progress) : merged;
      }
      return closeTool(s, u, timestamp);
    }
    case "plan":
      // 实时任务清单不进对话流:钉在 composer 上方的面板整卡更新
      // (引擎每次 Task*/TodoWrite 后全量重发;流内呈现无论追加还是
      // 原地更新都别扭——追加刷屏、固定没人看、跟随会跳)
      return { ...s, plan: u.entries ?? [] };
    case "llm_call_retry":
      // 仅云端流出现;渲染系统行让用户知道为什么"卡住了"
      return pushItem(s, { kind: "sys", text: `模型调用重试 #${u.attempt ?? "?"}: ${u.message ?? ""}` });
    case "task_notification": {
      // 后台子代理完成通知(📌):独立系统行。不能走流式追加——会把它
      // 并进正在流式的模型正文气泡。已回填后台卡时通知信息重复:消费卡上
      // 的 pending 标记,不再往对话流追加任何项
      for (let i = s.items.length - 1; i >= 0; i--) {
        const it = s.items[i];
        if (!it || it.kind !== "tool" || !it.backgroundNoticePending) continue;
        const items = s.items.slice();
        items[i] = { ...it, backgroundNoticePending: false };
        return { ...s, items, streamKind: "" };
      }
      return u.text ? pushItem(s, { kind: "sys", text: u.text }) : s;
    }
    case "available_commands_update":
      // 斜杠指令清单是"此刻"的会话状态(全量重发,不是对话内容):只回写
      // 状态字段,不进对话流;无名条目丢弃(菜单里点不出东西)
      return { ...s, commands: (u.availableCommands ?? []).filter((c) => !!c?.name) };
    case "usage_update":
      return { ...s, usage: { used: u.used ?? 0, size: u.size ?? 0 } };
    case "compact_status":
      return pushItem(s, {
        kind: "sys",
        text: u.status === "started" ? "⟳ 上下文接近上限,正在压缩…" : "⟳ 上下文压缩完成",
      });
    case "model_update": {
      // 系统行外显短名(先剥 @来源#配置id 的寻址后缀,再剥会员档位前缀);
      // 状态 model 保持原始名——它是按 name 回查模型/think 档的键
      const name = u.model ?? "";
      const shown = stripTierPrefix(stripSourceSuffix(name));
      return { ...pushItem(s, { kind: "sys", text: `模型已切换为 ${shown}` }), model: name };
    }
    case "think_update": {
      const level = u.think ?? "";
      const label = THINK_LABELS[level] ?? "默认";
      return { ...pushItem(s, { kind: "sys", text: `思考深度已调整为「${label}」` }), think: level };
    }
    case "permission_mode_update": {
      const mode = u.mode ?? "default";
      const text =
        mode === "yolo" ? "⚡ 已开启 YOLO 模式:所有操作不再询问,直接执行" : "已恢复默认权限模式";
      return { ...pushItem(s, { kind: "sys", text }), permMode: mode };
    }
    default:
      // 未知词汇原样返回:引擎/云端会长出新 sessionUpdate,归约不许炸
      return s;
  }
}

// ==================== 顶层帧归约 ====================

/** 单帧状态转移(不含 seq 去重——那是批次的事,见 reduceBatch)。 */
export function reduceFrame(s: ChatState, f: Frame): ChatState {
  switch (f.type) {
    case "task-started":
      // plan/todo 是轮次级状态:上一轮的最终清单可在结束后保留供回顾,
      // 新一轮开始时只清掉已全部完成的清单;还有未完成项则跨轮保留,
      // 直到本轮 plan 帧继续更新它
      return {
        ...s,
        running: true,
        plan: s.plan.length > 0 && s.plan.every((e) => e.status === "completed") ? [] : s.plan,
      };
    case "task-ended":
      return {
        ...s,
        running: false,
        streamKind: "",
        turnEnded: true,
        items: [...expireOpenAsks(s.items), { kind: "sys", text: "— 本轮结束 —" }],
      };
    case "task-error": {
      const data = frameData<{ error?: string }>(f);
      return {
        ...s,
        running: false,
        streamKind: "",
        items: [...expireOpenAsks(s.items), { kind: "sys", text: "✗ " + (data?.error || "未知错误"), error: true }],
      };
    }
    case "user-input": {
      const data = frameData<{ content?: string; attachments?: { url?: string; filename?: string }[] }>(f);
      const text = decodeUserInput(data?.content);
      // 云端附件({url, filename},与 web/mobile 契约一致):缺 filename 的
      // 旧帧用 URL 末段兜底;无 url 不可渲染,丢弃。本地会话帧无此字段
      const atts: ChatAttachment[] = [];
      for (const a of data?.attachments ?? []) {
        if (!a?.url) continue;
        atts.push({ url: a.url, filename: a.filename || a.url.split("/").pop() || "附件" });
      }
      return pushItem(s, {
        kind: "user",
        text,
        ...(f.timestamp !== undefined ? { timestamp: f.timestamp } : {}),
        // 大纲跳转的锚:壳的 session_outline 条目按同一 seq 对表
        ...(f.seq !== undefined ? { seq: f.seq } : {}),
        // 有才写:undefined/空数组键会污染测试的全等比较,语义上也该缺席
        ...(atts.length ? { attachments: atts } : {}),
      });
    }
    case "permission-req": {
      const data = frameData<{ id?: string; title?: string; tool?: string; tool_call_id?: string }>(f);
      if (!data?.id) return s;
      return pushItem(s, {
        kind: "perm",
        id: data.id,
        title: data.title ?? "",
        tool: data.tool ?? "",
        state: "open",
        // 有才写:undefined 键会污染测试的 toEqual 全等比较,且语义上
        // "没有锚点"就该是字段缺席而非空值
        ...(data.tool_call_id ? { toolCallId: data.tool_call_id } : {}),
      });
    }
    case "permission-resolved": {
      const data = frameData<{ id?: string; outcome?: string }>(f);
      if (!data?.id) return s;
      // 只落在开放卡上:已被本地乐观回写/前一终态占住的卡不再改写
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === "perm" && it.id === data.id && it.state === "open"
            ? { ...it, state: (data.outcome as PermOutcome | undefined) ?? "expired" }
            : it,
        ),
      };
    }
    case "task-running": {
      if (f.kind === "acp_event") {
        const data = frameData<{ update?: AcpUpdate }>(f);
        return data?.update ? reduceAcp(s, data.update, f.timestamp) : s;
      }
      if (f.kind === "acp_ask_user_question") {
        // 云端专用帧:{toolCall:{toolCallId, rawInput.questions, ...}}
        const data = frameData<{ toolCall?: AcpUpdate & Record<string, unknown> }>(f);
        const tc = data?.toolCall;
        const id = tc?.toolCallId;
        const qs = tc ? askQuestionsFrom(tc) : null;
        if (id && qs) return upsertAsk(s, id, qs, tc?.status === "completed");
        return s;
      }
      return s;
    }
    case "reply-question": {
      // 答案回显/回放:request_id 即 askId,answers_json = {问题: 答案}
      const data = frameData<{ request_id?: string; answers_json?: string; cancelled?: boolean }>(f);
      if (!data?.request_id) return s;
      let answers: Record<string, string | string[]> = {};
      try {
        answers = JSON.parse(data.answers_json ?? "{}") as Record<string, string | string[]>;
      } catch {
        // 坏载荷按无答案处理:卡片仍置 done(引擎确已收到答复)
      }
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === "ask" && it.askId === data.request_id
            ? { ...it, state: "done", questions: it.questions.map((q) => ({ ...q, answer: answers[q.question] })) }
            : it,
        ),
      };
    }
    default:
      // 未知帧原样返回(如云端 cursor/ping 由连接层滤,漏进来也不炸)
      return s;
  }
}

/** 批量归约 + seq 去重。
 *
 * 去重口径(为什么不是"滚动水位"):折叠回放的帧序**合法地不随 seq 单调**
 * ——壳把相邻流式碎片折成一帧钉在首片 seq 上、把覆盖语义帧(usage/plan)
 * 收敛到末片 seq 上,批内因此会出现 39 在 22 前面;拿批内滚动最大值去重
 * 会误杀折叠批里的合法帧。所以:
 * - 跨批次:seq 落在**批首水位**(state.lastSeq)之下的帧丢弃——云端
 *   重连的回放重叠帧属于这类;
 * - 批内:顺序可信,只丢**完全相同 seq** 的重复(同批里既回放又直播);
 * - 缺 seq/seq=0 的帧(云端旧帧)不参与去重,照常归约。
 * 水位单调抬升,永不回落;重连要重放全量时应从 createChatState() 重来。 */
export function reduceBatch(s: ChatState, batch: readonly Frame[]): ChatState {
  let next = s;
  let watermark = s.lastSeq;
  const seenInBatch = new Set<number>();
  for (const f of batch) {
    const seq = typeof f.seq === "number" && f.seq > 0 ? f.seq : null;
    if (seq !== null) {
      if (seq <= s.lastSeq || seenInBatch.has(seq)) continue;
      seenInBatch.add(seq);
      if (seq > watermark) watermark = seq;
    }
    next = reduceFrame(next, f);
  }
  return watermark === s.lastSeq ? next : { ...next, lastSeq: watermark };
}

/** 「加载更早」:把更早的一段历史帧归约后插到最前。
 *
 * 更早那段单独归约(不是接着当前状态跑):它只贡献 items——running/usage/
 * plan/model 都是"此刻"的状态,让过去的帧回写会把现状覆盖成历史值;
 * seq 水位同理保留现值(旧页 seq 都更小,不该动水位)。keyBase 同步左移,
 * 既有条目的渲染 key 不变(机制见 ChatState.keyBase)。 */
export function prependHistory(s: ChatState, batch: readonly Frame[]): ChatState {
  const older = reduceBatch(createChatState(), batch);
  if (older.items.length === 0) return s;
  return {
    ...s,
    items: [...older.items, ...s.items],
    keyBase: s.keyBase - older.items.length,
  };
}

/** 渲染 key:keyBase + 下标(前插历史时二者同步平移,和恒定)。 */
export function itemKey(s: ChatState, index: number): number {
  return s.keyBase + index;
}

// ==================== 视图侧的状态推导与乐观回写 ====================

/** 待决审批 → 工具卡锚定(tcId → perm 项)。审批 UX 终态:perm 带
 * toolCallId 且流里存在同 id 的工具卡(引擎保证 tool_call 帧先于
 * permission-req 到达)时,审批按钮嵌进那张工具卡内部,独立审批大卡
 * 不再渲染;已决(state 非 open)即解除锚定,按钮行消失、卡片回归
 * 正常 run/ok/fail 流转。纯函数放归约层而非组件:锚定是状态推导,
 * 对话流视图与测试共用同一份判定。 */
export function permAnchors(items: readonly ChatItem[]): Map<string, PermItem> {
  const tools = new Set<string>();
  for (const it of items) if (it.kind === "tool" && it.tcId) tools.add(it.tcId);
  const map = new Map<string, PermItem>();
  for (const it of items) {
    if (it.kind === "perm" && it.state === "open" && it.toolCallId && tools.has(it.toolCallId)) {
      map.set(it.toolCallId, it);
    }
  }
  return map;
}

/** 本地答复审批卡(点击按钮后立即回写 UI,不等 resolved 帧)。 */
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

/** 本地答复提问卡(提交后立即回写 UI,不等 reply-question 回显)。 */
export function answerAsk(s: ChatState, askId: string, answers: Record<string, string | string[]>): ChatState {
  return {
    ...s,
    items: s.items.map((it) =>
      it.kind === "ask" && it.askId === askId && it.state === "open"
        ? { ...it, state: "done", questions: it.questions.map((q) => ({ ...q, answer: answers[q.question] })) }
        : it,
    ),
  };
}
