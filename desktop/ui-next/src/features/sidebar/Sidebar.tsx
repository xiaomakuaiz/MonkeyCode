// 侧栏:三空间(云端/本地/会话)列表面板。
// 设计基线 = 旧 UI(desktop/ui/src/sidebar.tsx)的桌面密度语言,实现绿地:
// - 面板头 52px:空间标题 + 计数副标题 + 强调色「+」;下接内嵌搜索框
// - 本地行两行式(34px):标题 + 状态尾注(10.5px)/ 摘要行;对话行单行
// - 尾注只在要紧态着色(等待确认/运行中/运行出错),平时给轮次或可继续
// - 行菜单 = 右键(重命名/归档/删除二段确认),行面干净无按钮
// - 项目组:文件夹头 + hover「+在此新建」+ 右键 + HTML5 拖拽排序(落点线)
// - 归档:项目内「已归档任务 · N」小节 + 底部「已归档项目 · N」,开合态
//   走旧 UI 契约键;搜索非空强制展开全部折叠段(不写盘)
import { MessagesSquare, Monitor, Plus, RefreshCw, Search, X } from "lucide-react";
import { useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";

import { EmptyState, GroupHeader } from "@/components/sidekit";
import { CloudTaskList } from "@/features/cloud/CloudTaskList";
import { useUpdate } from "@/features/update/useUpdate";
import { openMenu, type MenuItem } from "@/lib/contextMenu";
import { useI18n } from "@/lib/i18n";
import type { SessionMeta } from "@/lib/ipc/sessions";
import {
  groupSessions,
  readArchivedProjects,
  readCollapsedGroups,
  readProjectOrder,
  readSessionArchivesOpen,
  reorderKeys,
  writeArchivedProjects,
  writeCollapsedGroups,
  writeProjectOrder,
  writeSessionArchivesOpen,
  type ProjectGroup,
} from "@/lib/util/projects";
import { readFold, writeFold, type Space } from "@/lib/util/prefs";

export interface SidebarActions {
  onSelect: (meta: SessionMeta) => void;
  onDelete: (meta: SessionMeta) => void;
  onToggleArchive: (meta: SessionMeta) => void;
  onRename: (meta: SessionMeta, title: string) => void;
  onNewTask: () => void;
  /** 项目组头「在此新建任务」:预填该项目目录 */
  onNewTaskIn: (workdir: string) => void;
}

type T = ReturnType<typeof useI18n>["t"];

/** 行状态词(旧 UI rowStatus):要紧态着色,静默态低调。 */
function rowState(meta: SessionMeta, t: T): { text: string; cls: string; dot: string } {
  if (meta.waiting_ask) return { text: t("status.waitingAsk"), cls: "text-warning", dot: "bg-warning" };
  switch (meta.status) {
    case "running":
      return { text: t("status.running"), cls: "text-primary", dot: "bg-primary" };
    case "error":
      return { text: t("status.error"), cls: "text-error", dot: "bg-error" };
    case "interrupted":
      return { text: t("status.interrupted"), cls: "text-base-content/55", dot: "" };
    case "idle":
    case "finished":
      return { text: t("status.idle"), cls: "text-base-content/55", dot: "" };
    default:
      return meta.turns > 0
        ? { text: t("status.idle"), cls: "text-base-content/55", dot: "" }
        : { text: t("status.notStarted"), cls: "text-base-content/45", dot: "" };
  }
}

interface RowPlumbing {
  currentId: string | null;
  actions: SidebarActions;
  attentionIds?: Set<string>;
  renamingId: string | null;
  onRenameStart: (id: string) => void;
  onRenameEnd: () => void;
}

function SessionRow({ meta, depth = 0, archived = false, p }: { meta: SessionMeta; depth?: number; archived?: boolean; p: RowPlumbing }) {
  const { t } = useI18n();
  const attention = p.attentionIds?.has(meta.id) ?? false;

  if (p.renamingId === meta.id) {
    const commit = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing) return; // IME 组字回车不提交
      if (e.key === "Escape") return p.onRenameEnd();
      if (e.key !== "Enter") return;
      const title = e.currentTarget.value.trim();
      if (title && title !== meta.title) p.actions.onRename(meta, title);
      p.onRenameEnd();
    };
    return (
      <div className="flex min-h-[34px] items-center pe-2" style={{ paddingInlineStart: 11 + Math.max(0, depth) * 14 }}>
        <input
          type="text"
          aria-label={t("sidebar.row.rename")}
          className="h-6 min-w-0 flex-1 rounded-[5px] border border-primary/25 bg-base-100 px-1.5 text-[12.5px] text-base-content outline-none"
          defaultValue={meta.title}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={commit}
          onBlur={p.onRenameEnd}
        />
      </div>
    );
  }

  const st = rowState(meta, t);
  const isChat = meta.kind === "chat";
  const primary = isChat && meta.summary ? meta.summary : meta.title;
  const emphasize = !!meta.waiting_ask || meta.status === "running" || meta.status === "error";
  const showState = emphasize || meta.status === "interrupted";
  const turns = meta.turns > 0 ? t("status.turns", { n: String(Math.trunc(meta.turns)) }) : "";
  const trailing = showState ? st.text : turns || st.text;
  const active = meta.id === p.currentId;
  const trailingCls = archived ? "text-base-content/35" : showState ? st.cls : active ? "text-primary/60" : "text-base-content/45";
  const menuItems: MenuItem[] = [
    { label: t("sidebar.row.rename"), run: () => p.onRenameStart(meta.id) },
    { label: meta.archived ? t("sidebar.row.unarchive") : t("sidebar.row.archive"), run: () => p.actions.onToggleArchive(meta) },
    { label: t("sidebar.row.delete"), confirm: t("sidebar.row.deleteConfirm"), danger: true, run: () => p.actions.onDelete(meta) },
  ];

  return (
    <div
      role="button"
      tabIndex={0}
      data-attention={attention ? "" : undefined}
      title={`${meta.title}\n${meta.summary ? `${meta.summary}\n` : ""}${isChat ? t("sidebar.row.chatDetail") : meta.workdir}\n${t("sidebar.row.hint")}`}
      className={`flex min-h-[34px] cursor-pointer items-center gap-[7px] rounded-[7px] py-[5px] pe-2 ${
        active ? (archived ? "bg-base-content/10" : "bg-primary/10") : "hover:bg-base-content/5"
      }`}
      style={{ paddingInlineStart: 11 + Math.max(0, depth) * 14 }}
      onClick={() => p.actions.onSelect(meta)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          p.actions.onSelect(meta);
        }
      }}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu({ x: e.clientX, y: e.clientY }, menuItems);
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <div className="flex min-w-0 items-center gap-[7px]">
          <span
            className={`min-w-0 flex-1 truncate text-[12.5px] leading-[1.35] ${
              active ? "text-base-content" : archived ? "text-base-content/55" : "text-base-content/90"
            }`}
          >
            {primary}
          </span>
          <span className="flex flex-none items-center gap-[5px]">
            {(attention || emphasize) && (
              <span
                aria-hidden
                title={attention ? (meta.status === "error" ? t("notice.error", { title: meta.title }) : t("notice.done", { title: meta.title })) : undefined}
                className={`flex-none rounded-full ${
                  attention
                    ? `h-[7px] w-[7px] ring-2 ${meta.status === "error" ? "bg-error ring-error/15" : "bg-primary ring-primary/15"}`
                    : `h-1.5 w-1.5 ${st.dot}`
                }`}
              />
            )}
            <span className={`max-w-[60px] truncate text-[10.5px] leading-[1.2] tabular-nums ${trailingCls}`}>{trailing}</span>
          </span>
        </div>
        {!isChat && meta.summary && (
          <span className={`truncate text-[11px] leading-[1.3] ${archived ? "text-base-content/35" : active ? "text-base-content/55" : "text-base-content/45"}`}>
            {meta.summary}
          </span>
        )}
      </div>
    </div>
  );
}

/** 一个项目分组(含其「已归档任务」小节)。 */
function ProjectSection({
  group,
  depth = 0,
  archivedProject = false,
  p,
  forceOpen,
  collapsed,
  onToggleCollapsed,
  archOpen,
  onToggleArchOpen,
  onProjectArchiveToggle,
  drag,
  dropTarget,
}: {
  group: ProjectGroup;
  depth?: number;
  archivedProject?: boolean;
  p: RowPlumbing;
  forceOpen: boolean;
  collapsed: boolean;
  onToggleCollapsed: (key: string) => void;
  archOpen: boolean;
  onToggleArchOpen: (key: string) => void;
  onProjectArchiveToggle: (key: string) => void;
  drag?: {
    onDragStart: (key: string) => void;
    onDragOver: (key: string) => void;
    onDragEnd: () => void;
    onDropBefore: (key: string) => void;
  };
  dropTarget?: boolean;
}) {
  const { t } = useI18n();
  const expanded = forceOpen || !collapsed;
  const menuItems: MenuItem[] = [
    ...(archivedProject ? [] : [{ label: t("sidebar.project.newTaskIn"), run: () => p.actions.onNewTaskIn(group.key) }]),
    {
      label: archivedProject ? t("sidebar.project.unarchive") : t("sidebar.project.archive"),
      run: () => onProjectArchiveToggle(group.key),
    },
  ];
  return (
    <div className="flex flex-col gap-px">
      <GroupHeader
        project
        name={group.name}
        archived={archivedProject}
        depth={depth}
        expanded={expanded}
        onToggle={() => onToggleCollapsed(group.key)}
        title={[group.key, t("sidebar.project.hint"), drag ? t("sidebar.project.dragHint") : ""].filter(Boolean).join("\n")}
        quickAdd={archivedProject ? undefined : { label: t("sidebar.project.newTask"), onClick: () => p.actions.onNewTaskIn(group.key) }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu({ x: e.clientX, y: e.clientY }, menuItems);
        }}
        drag={
          drag && {
            onDragStart: () => drag.onDragStart(group.key),
            onDragOver: (e: DragEvent) => {
              e.preventDefault();
              drag.onDragOver(group.key);
            },
            onDragEnd: () => drag.onDragEnd(),
            onDrop: (e: DragEvent) => {
              e.preventDefault();
              drag.onDropBefore(group.key);
            },
          }
        }
        dropTarget={dropTarget}
      />
      {expanded && (
        <div className="flex flex-col gap-0.5 pb-1.5">
          {group.sessions.map((m) => (
            <SessionRow key={m.id} meta={m} depth={depth + 1} p={p} />
          ))}
          {group.archivedSessions.length > 0 && (
            <>
              <GroupHeader
                muted
                depth={depth + 1}
                name={t("sidebar.archivedTasks", { n: String(group.archivedSessions.length) })}
                expanded={forceOpen || archOpen}
                onToggle={() => onToggleArchOpen(group.key)}
              />
              {(forceOpen || archOpen) &&
                group.archivedSessions.map((m) => <SessionRow key={m.id} meta={m} depth={depth + 2} archived p={p} />)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  space,
  sessions,
  currentId,
  actions,
  attentionIds,
  cloud,
}: {
  space: Space;
  sessions: SessionMeta[];
  currentId: string | null;
  actions: SidebarActions;
  /** 后台提醒未读的会话 id 集(D3):命中行状态点放大加光晕 */
  attentionIds?: Set<string>;
  /** 云端空间的数据接线(App 提供;缺省时云端页为空列表) */
  cloud?: {
    currentId: string | null;
    onSelect: (task: import("@/lib/ipc/cloudtasks").CloudTask) => void;
    reloadKey: number;
    onDeleted?: (id: string) => void;
    onRefresh?: () => void;
  };
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<string[]>(readProjectOrder);
  const [archivedProjects, setArchivedProjects] = useState<Set<string>>(readArchivedProjects);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedGroups);
  const [sessionArchOpen, setSessionArchOpen] = useState<Set<string>>(readSessionArchivesOpen);
  const [chatArchOpen, setChatArchOpen] = useState<boolean>(() => readFold("mc.archivedOpen"));
  const [projArchOpen, setProjArchOpen] = useState<boolean>(() => readFold("mc.projectArchiveOpen"));
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [cloudCounts, setCloudCounts] = useState<{ projects: number; tasks: number } | null>(null);

  const q = query.trim().toLowerCase();
  const forceOpen = q !== "";
  const matches = (m: SessionMeta) =>
    !q || m.title.toLowerCase().includes(q) || (m.summary ?? "").toLowerCase().includes(q) || m.workdir.toLowerCase().includes(q);

  const p: RowPlumbing = {
    currentId,
    actions,
    attentionIds,
    renamingId,
    onRenameStart: setRenamingId,
    onRenameEnd: () => setRenamingId(null),
  };

  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsedGroups(next);
      return next;
    });
  };

  const toggleSessionArchOpen = (key: string) => {
    setSessionArchOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeSessionArchivesOpen(next);
      return next;
    });
  };

  const toggleProjectArchive = (key: string) => {
    setArchivedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeArchivedProjects(next);
      return next;
    });
  };

  // ---- 空间内容与面板头(标题/计数/动作)----

  const localPool = sessions.filter((m) => m.kind !== "chat");
  const chatPool = sessions.filter((m) => m.kind === "chat");

  const head = (() => {
    if (space === "cloud")
      return {
        title: t("sidebar.head.cloud"),
        detail: cloudCounts ? t("sidebar.head.cloudDetail", { projects: String(cloudCounts.projects), tasks: String(cloudCounts.tasks) }) : "",
        placeholder: t("sidebar.searchTasks"),
      };
    if (space === "chat")
      return {
        title: t("sidebar.head.chat"),
        detail: t("sidebar.head.chatDetail", { n: String(chatPool.filter((m) => !m.archived).length) }),
        placeholder: t("sidebar.search"),
      };
    const grouped = groupSessions(localPool, order, archivedProjects);
    return {
      title: t("sidebar.head.local"),
      detail: t("sidebar.head.localDetail", {
        projects: String(grouped.projects.length),
        tasks: String(localPool.filter((m) => !m.archived).length),
      }),
      placeholder: t("sidebar.searchTasks"),
    };
  })();

  const body = () => {
    if (space === "cloud") {
      return (
        <CloudTaskList
          currentId={cloud?.currentId ?? null}
          onSelect={(task) => cloud?.onSelect(task)}
          reloadKey={cloud?.reloadKey ?? 0}
          onDeleted={cloud?.onDeleted}
          query={q}
          onCounts={setCloudCounts}
        />
      );
    }

    if (space === "chat") {
      const pool = chatPool.filter(matches);
      const chats = pool.filter((m) => !m.archived);
      const archivedChats = pool.filter((m) => m.archived);
      return (
        <>
          {chats.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {chats.map((m) => (
                <SessionRow key={m.id} meta={m} p={p} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<MessagesSquare size={19} strokeWidth={1.75} aria-hidden />}
              title={q ? t("sidebar.noResults.chat.title") : t("sidebar.empty.chat.title")}
              detail={q ? t("sidebar.noResults.chat.detail") : t("sidebar.empty.chat.detail")}
            />
          )}
          {archivedChats.length > 0 && (
            <>
              <GroupHeader
                muted
                name={t("sidebar.archivedChats", { n: String(archivedChats.length) })}
                expanded={forceOpen || chatArchOpen}
                onToggle={() => {
                  setChatArchOpen((v) => {
                    writeFold("mc.archivedOpen", !v);
                    return !v;
                  });
                }}
              />
              {(forceOpen || chatArchOpen) && (
                <div className="flex flex-col gap-0.5 pb-1.5">
                  {archivedChats.map((m) => (
                    <SessionRow key={m.id} meta={m} depth={1} archived p={p} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      );
    }

    const grouped = groupSessions(localPool.filter(matches), order, archivedProjects);
    const visibleKeys = grouped.projects.map((g) => g.key);
    const drag = {
      onDragStart: (key: string) => setDraggedKey(key),
      onDragOver: (key: string) => setDragOverKey((prev) => (prev === key ? prev : key)),
      onDragEnd: () => {
        setDraggedKey(null);
        setDragOverKey(null);
      },
      onDropBefore: (before: string) => {
        setDragOverKey(null);
        if (!draggedKey || draggedKey === before) return;
        const next = reorderKeys(visibleKeys, draggedKey, before);
        setOrder(next);
        writeProjectOrder(next);
        setDraggedKey(null);
      },
    };
    return (
      <>
        {grouped.projects.map((group) => (
          <ProjectSection
            key={group.key}
            group={group}
            p={p}
            forceOpen={forceOpen}
            collapsed={collapsed.has(group.key)}
            onToggleCollapsed={toggleCollapsed}
            archOpen={sessionArchOpen.has(group.key)}
            onToggleArchOpen={toggleSessionArchOpen}
            onProjectArchiveToggle={toggleProjectArchive}
            drag={drag}
            dropTarget={dragOverKey === group.key && draggedKey !== null && draggedKey !== group.key}
          />
        ))}
        {grouped.projects.length === 0 && grouped.archivedProjects.length === 0 && (
          <EmptyState
            icon={q ? <Search size={19} strokeWidth={1.75} aria-hidden /> : <Monitor size={19} strokeWidth={1.5} aria-hidden />}
            title={q ? t("sidebar.noResults.local.title") : t("sidebar.empty.local.title")}
            detail={q ? t("sidebar.noResults.local.detail") : t("sidebar.empty.local.detail")}
          />
        )}
        {grouped.archivedProjects.length > 0 && (
          <>
            <GroupHeader
              muted
              name={t("sidebar.archivedProjects", { n: String(grouped.archivedProjects.length) })}
              expanded={forceOpen || projArchOpen}
              onToggle={() => {
                setProjArchOpen((v) => {
                  writeFold("mc.projectArchiveOpen", !v);
                  return !v;
                });
              }}
            />
            {(forceOpen || projArchOpen) && (
              <div className="flex flex-col gap-px pb-1.5">
                {grouped.archivedProjects.map((group) => (
                  <ProjectSection
                    key={group.key}
                    group={group}
                    depth={1}
                    archivedProject
                    p={p}
                    forceOpen={forceOpen}
                    collapsed={collapsed.has(group.key)}
                    onToggleCollapsed={toggleCollapsed}
                    archOpen={sessionArchOpen.has(group.key)}
                    onToggleArchOpen={toggleSessionArchOpen}
                    onProjectArchiveToggle={toggleProjectArchive}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </>
    );
  };

  return (
    <aside aria-label={t("sidebar.label")} className="flex w-side shrink-0 flex-col border-e border-base-300 bg-base-200">
      {/* 面板头 52px:空间标题 + 计数副标题;空白处可拖拽窗口(§7:属性不继承,逐子节点带) */}
      <div data-tauri-drag-region="" className="flex h-[52px] flex-none items-center gap-2 pe-[11px] ps-[13px]">
        <span data-tauri-drag-region="" className="flex min-w-0 flex-col gap-px">
          <span data-tauri-drag-region="" className="text-sm font-bold text-base-content">
            {head.title}
          </span>
          <span data-tauri-drag-region="" className="truncate text-[10.5px] text-base-content/45">
            {head.detail}
          </span>
        </span>
        <span data-tauri-drag-region="" className="min-w-0 flex-1" />
        {space === "cloud" && cloud?.onRefresh && (
          <button
            type="button"
            aria-label={t("cloud.list.refresh")}
            title={t("cloud.list.refresh")}
            className="btn btn-ghost btn-square btn-xs"
            onClick={cloud.onRefresh}
          >
            <RefreshCw size={12} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        <button
          type="button"
          aria-label={t("sidebar.newTask")}
          title={t("sidebar.newTask")}
          className="btn btn-primary btn-square btn-xs"
          onClick={actions.onNewTask}
        >
          <Plus size={13} strokeWidth={2} aria-hidden />
        </button>
      </div>
      {/* 搜索框:daisyUI input 底座,收窄成旧 UI 的内嵌形态;query 非空出清空钮 */}
      <label className="input input-sm mx-2.5 mb-2 h-8 w-auto flex-none rounded-[9px] bg-base-100/90 text-[11.5px]">
        <Search size={12} strokeWidth={1.75} className="flex-none opacity-50" aria-hidden />
        <input
          type="search"
          aria-label={t("sidebar.search")}
          placeholder={head.placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query !== "" && (
          <button
            type="button"
            aria-label={t("sidebar.clearSearch")}
            className="btn btn-ghost btn-square h-[18px] w-[18px] min-h-0 flex-none rounded-[5px]"
            onClick={() => setQuery("")}
          >
            <X size={9} strokeWidth={2} aria-hidden />
          </button>
        )}
      </label>
      {/* 列表 = 唯一滚动区(纵滚横截;固定滚动槽,行宽不随滚动条出没抖动) */}
      <div className="flex min-h-0 flex-1 flex-col gap-[3px] overflow-x-hidden overflow-y-auto pb-2.5 pe-px ps-[9px] [overscroll-behavior:contain] [scrollbar-gutter:stable]">
        {body()}
      </div>
      <div className="shrink-0 empty:hidden">
        <UpdateFooter />
      </div>
    </aside>
  );
}

function UpdateFooter() {
  const { t } = useI18n();
  const { update, installing, error, install } = useUpdate();
  if (!update?.available) return null;
  // 卡片式常驻条(旧 UI 形态):提示点 + 文案 + 行动词;失败换错误色外显原因
  return (
    <button
      type="button"
      role={error ? "alert" : undefined}
      disabled={installing}
      onClick={install}
      title={error ?? undefined}
      className="mx-[9px] mb-[9px] mt-1.5 flex min-h-9 items-center gap-[7px] rounded-[9px] border border-base-content/10 bg-base-100 px-[9px] py-[7px] text-start hover:bg-base-content/5"
    >
      <span
        aria-hidden
        className={`h-[7px] w-[7px] flex-none rounded-full ${error ? "bg-error" : "bg-warning"} ${installing ? "animate-pulse" : ""}`}
      />
      <span className={`min-w-0 flex-1 truncate text-[11.5px] font-semibold ${error ? "text-error" : "text-base-content/90"}`}>
        {error ? t("update.failed", { reason: error }) : t("update.available", { version: update.latest ?? "" })}
      </span>
      {!installing && <span className="flex-none text-[10.5px] font-bold text-primary">{t("update.install")}</span>}
      {installing && <span className="loading loading-spinner loading-xs flex-none" aria-hidden />}
    </button>
  );
}
