// 侧栏项目分组的纯逻辑:key 归一化、手动排序与项目归档的持久化、分组计算。
// localStorage 键与取值格式 = 旧 UI 契约(mc.projectOrder / mc.archivedProjects
// 均为 JSON string[],key 做跨平台归一),换 UI 不丢用户的整理成果。
import type { SessionMeta } from "@/lib/ipc/sessions";

const ORDER_KEY = "mc.projectOrder";
const ARCHIVED_KEY = "mc.archivedProjects";

/** 项目 key:分隔符统一为 `/`、去尾斜杠("/" 本身除外)。
 *  Windows 写入的顺序在 macOS 读出来必须还认识,靠这套归一。 */
export function projectKey(workdir: string): string {
  const normalized = workdir.trim().replace(/\\/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

/** 项目展示名 = 目录末段。 */
export function projectName(workdir: string): string {
  const key = projectKey(workdir);
  return key.split("/").filter(Boolean).at(-1) ?? key;
}

function readStringArray(storageKey: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function dedupeKeys(dirs: readonly string[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const key = projectKey(dir);
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** 手动顺序是"全序快照":空数组 = 用户从未拖动,保持按活跃度排序。 */
export function readProjectOrder(): string[] {
  return dedupeKeys(readStringArray(ORDER_KEY));
}

export function writeProjectOrder(keys: readonly string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(dedupeKeys(keys)));
  } catch {
    // 只丢持久化
  }
}

export function readArchivedProjects(): Set<string> {
  return new Set(dedupeKeys(readStringArray(ARCHIVED_KEY)));
}

export function writeArchivedProjects(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify([...keys]));
  } catch {
    // 只丢持久化
  }
}

/** 拖拽落点计算:把 dragged 移到 before 之前(before 为 null 即移到末尾)。 */
export function reorderKeys(keys: readonly string[], dragged: string, before: string | null): string[] {
  const rest = keys.filter((k) => k !== dragged);
  if (before === null || !rest.includes(before)) return [...rest, dragged];
  const at = rest.indexOf(before);
  return [...rest.slice(0, at), dragged, ...rest.slice(at)];
}

const COLLAPSED_KEY = "mc.collapsedGroups";

export function readCollapsedGroups(): Set<string> {
  return new Set(readStringArray(COLLAPSED_KEY));
}

export function writeCollapsedGroups(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    // 只丢持久化
  }
}

/** 各项目「已归档任务」小节的展开集(键 = 项目 key;JSON string[] = 旧 UI 契约)。 */
const SESSION_ARCHIVES_KEY = "mc.sessionArchivesOpen";

export function readSessionArchivesOpen(): Set<string> {
  return new Set(readStringArray(SESSION_ARCHIVES_KEY));
}

export function writeSessionArchivesOpen(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(SESSION_ARCHIVES_KEY, JSON.stringify([...keys]));
  } catch {
    // 只丢持久化
  }
}

export interface ProjectGroup {
  key: string;
  name: string;
  sessions: SessionMeta[];
  archivedSessions: SessionMeta[];
}

export interface GroupedSessions {
  projects: ProjectGroup[];
  archivedProjects: ProjectGroup[];
}

/** local 空间分组:按项目聚合 → 手动顺序优先(未入序的按组内最近活跃追尾)
 *  → 项目归档与会话归档各自折叠。传入前先按空间过滤(kind)。 */
export function groupSessions(
  sessions: readonly SessionMeta[],
  order: readonly string[],
  archivedProjects: ReadonlySet<string>,
): GroupedSessions {
  const byProject = new Map<string, ProjectGroup>();
  for (const meta of sessions) {
    const key = projectKey(meta.workdir);
    let group = byProject.get(key);
    if (!group) {
      group = { key, name: projectName(meta.workdir), sessions: [], archivedSessions: [] };
      byProject.set(key, group);
    }
    (meta.archived ? group.archivedSessions : group.sessions).push(meta);
  }

  const activity = (group: ProjectGroup): string =>
    [...group.sessions, ...group.archivedSessions].reduce((max, m) => {
      const at = m.updated_at ?? "";
      return at > max ? at : max;
    }, "");

  const all = [...byProject.values()].sort((a, b) => activity(b).localeCompare(activity(a)));
  const rank = new Map(order.map((key, i) => [key, i]));
  all.sort((a, b) => {
    const ra = rank.get(a.key);
    const rb = rank.get(b.key);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0; // 都不在手动序里:保持活跃度序(sort 稳定)
  });

  const projects: ProjectGroup[] = [];
  const archived: ProjectGroup[] = [];
  for (const group of all) (archivedProjects.has(group.key) ? archived : projects).push(group);
  return { projects, archivedProjects: archived };
}
