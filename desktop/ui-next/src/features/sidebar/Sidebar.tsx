// 侧栏:三空间(本地/云端/对话)+ 会话列表。
// 分层约定(tasks/lessons.md 2026-08-04):
// - 壳布局不动:h-13 品牌头(LAYOUT.md §2)→ 列表滚动区 → footer;
// - 信息布局(用户定案):行单行 = 状态点 + 摘要‖标题 + 状态尾注殿后
//   (要紧态着色,静默态给轮次/可继续);组头 = 文件夹图标 + 项目名 +
//   等待徽标 + 快捷「+」殿后;项目内「已归档任务 · N」小节、底部
//   「已归档项目 · N」;
// - 组件一律 daisyUI 原生形态:menu(details 折叠)、status 状态点、badge、
//   btn、右键菜单走 lib/contextMenu(menu 皮相)。
// 行交互:右键 = 行菜单(重命名/归档/删除二段确认)。
import { Folder, Inbox, MessagesSquare, Plus, RefreshCw } from "lucide-react";
import { useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { CloudTaskList } from "@/features/cloud/CloudTaskList";
import { Brand } from "@/features/titlebar/TitleBar";
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

function StatusDot({ meta, attention }: { meta: SessionMeta; attention?: boolean }) {
  if (meta.waiting_ask) return <span aria-hidden className="status status-warning animate-pulse" />;
  // 后台提醒未读(D3):终态也用警示色点出来,点开行即消
  if (attention) return <span aria-hidden className="status status-warning" />;
  if (meta.status === "running") return <span aria-hidden className="status status-primary animate-pulse" />;
  if (meta.status === "error") return <span aria-hidden className="status status-error" />;
  return <span aria-hidden className="status opacity-30" />;
}

/** 行状态尾注(旧 UI 信息布局):要紧态着色词,静默态给轮次/可继续。 */
function rowTrailing(meta: SessionMeta, t: T): { text: string; cls: string } {
  if (meta.waiting_ask) return { text: t("status.waitingAsk"), cls: "text-warning" };
  if (meta.status === "running") return { text: t("status.running"), cls: "text-primary" };
  if (meta.status === "error") return { text: t("status.error"), cls: "text-error" };
  if (meta.status === "interrupted") return { text: t("status.interrupted"), cls: "text-base-content/50" };
  const turns = meta.turns > 0 ? t("status.turns", { n: String(Math.trunc(meta.turns)) }) : "";
  if (turns) return { text: turns, cls: "text-base-content/50" };
  return meta.status === "idle" || meta.status === "finished"
    ? { text: t("status.idle"), cls: "text-base-content/50" }
    : { text: t("status.notStarted"), cls: "text-base-content/35" };
}

interface RowPlumbing {
  currentId: string | null;
  actions: SidebarActions;
  attentionIds?: Set<string>;
  renamingId: string | null;
  onRenameStart: (id: string) => void;
  onRenameEnd: () => void;
}

function SessionRow({ meta, p }: { meta: SessionMeta; p: RowPlumbing }) {
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
      <li>
        <div className="min-h-8 p-1">
          <input
            type="text"
            aria-label={t("sidebar.row.rename")}
            className="input input-xs w-full"
            defaultValue={meta.title}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={commit}
            onBlur={p.onRenameEnd}
          />
        </div>
      </li>
    );
  }

  const isChat = meta.kind === "chat";
  // 单行(用户定案):有摘要给摘要(随对话演进,比标题达意),缺席回落标题
  const primary = meta.summary || meta.title;
  const trailing = rowTrailing(meta, t);
  const menuItems: MenuItem[] = [
    { label: t("sidebar.row.rename"), run: () => p.onRenameStart(meta.id) },
    { label: meta.archived ? t("sidebar.row.unarchive") : t("sidebar.row.archive"), run: () => p.actions.onToggleArchive(meta) },
    { label: t("sidebar.row.delete"), confirm: t("sidebar.row.deleteConfirm"), danger: true, run: () => p.actions.onDelete(meta) },
  ];
  return (
    <li>
      <a
        className={`flex min-w-0 items-center gap-2 overflow-hidden transition-colors duration-150 ${meta.id === p.currentId ? "menu-active" : ""}${attention ? " bg-warning/10" : ""}`}
        data-attention={attention ? "" : undefined}
        title={`${meta.title}\n${meta.summary ? `${meta.summary}\n` : ""}${isChat ? t("sidebar.row.chatDetail") : meta.workdir}\n${t("sidebar.row.hint")}`}
        onClick={() => p.actions.onSelect(meta)}
        onContextMenu={(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu({ x: e.clientX, y: e.clientY }, menuItems);
        }}
      >
        <StatusDot meta={meta} attention={attention} />
        <span className="min-w-0 flex-1 truncate">{primary}</span>
        <span className={`max-w-16 shrink-0 truncate text-xs tabular-nums ${trailing.cls}`}>{trailing.text}</span>
      </a>
    </li>
  );
}

function rows(list: SessionMeta[], p: RowPlumbing) {
  return list.map((meta) => <SessionRow key={meta.id} meta={meta} p={p} />);
}

/** 一个项目分组(daisyUI menu 的 details 折叠;含「已归档任务 · N」小节)。 */
function ProjectDetails({
  group,
  p,
  collapsed,
  onToggleCollapsed,
  archOpen,
  onToggleArchOpen,
  onProjectArchiveToggle,
  archivedProject,
  drag,
  dropTarget,
}: {
  group: ProjectGroup;
  p: RowPlumbing;
  collapsed: boolean;
  onToggleCollapsed: (key: string, open: boolean) => void;
  archOpen: boolean;
  onToggleArchOpen: (key: string) => void;
  onProjectArchiveToggle: (key: string) => void;
  archivedProject: boolean;
  drag?: {
    onDragStart: (key: string) => void;
    onDragOver: (key: string) => void;
    onDragEnd: () => void;
    onDropBefore: (key: string) => void;
  };
  dropTarget?: boolean;
}) {
  const { t } = useI18n();
  const waiting = group.sessions.filter((s) => s.waiting_ask).length;
  const menuItems: MenuItem[] = [
    ...(archivedProject ? [] : [{ label: t("sidebar.project.newTaskIn"), run: () => p.actions.onNewTaskIn(group.key) }]),
    {
      label: archivedProject ? t("sidebar.project.unarchive") : t("sidebar.project.archive"),
      run: () => onProjectArchiveToggle(group.key),
    },
  ];
  return (
    <li>
      <details
        open={!collapsed}
        onToggle={(e) => onToggleCollapsed(group.key, (e.target as HTMLDetailsElement).open)}
      >
        <summary
          className={`group ${dropTarget ? "border-t-2 border-primary" : ""}`}
          title={[group.key, t("sidebar.project.hint"), drag ? t("sidebar.project.dragHint") : ""].filter(Boolean).join("\n")}
          draggable={!!drag}
          onDragStart={() => drag?.onDragStart(group.key)}
          onDragOver={(e: DragEvent) => {
            if (!drag) return;
            e.preventDefault();
            drag.onDragOver(group.key);
          }}
          onDragEnd={() => drag?.onDragEnd()}
          onDrop={(e: DragEvent) => {
            e.preventDefault();
            drag?.onDropBefore(group.key);
          }}
          onContextMenu={(e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu({ x: e.clientX, y: e.clientY }, menuItems);
          }}
        >
          <Folder size={13} strokeWidth={1.75} className="shrink-0 text-base-content/50" aria-hidden />
          {/* menu 组头是 grid(图标/自动伸展列/尾部),名字占第二列自动撑满,+ 自然殿后 */}
          <span className="min-w-0 truncate text-xs font-medium text-base-content/70">{group.name}</span>
          {waiting > 0 && <span className="badge badge-warning badge-xs">{waiting}</span>}
          {/* 快捷钮常驻占位、hover 只切可见性:插入式显隐会挤动项目名,鼠标一进一出就抖 */}
          {!archivedProject && (
            <button
              type="button"
              aria-label={t("sidebar.project.newTask")}
              title={t("sidebar.project.newTask")}
              className="btn btn-ghost btn-square btn-xs invisible group-hover:visible group-focus-within:visible"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                p.actions.onNewTaskIn(group.key);
              }}
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </summary>
        <ul className="min-w-0 before:hidden">
          {rows(group.sessions, p)}
          {group.archivedSessions.length > 0 && (
            <li>
              <details open={archOpen} onToggle={(e) => {
                const open = (e.target as HTMLDetailsElement).open;
                if (open !== archOpen) onToggleArchOpen(group.key);
              }}>
                <summary className="text-xs text-base-content/50">
                  {t("sidebar.archivedTasks", { n: String(group.archivedSessions.length) })}
                </summary>
                <ul className="min-w-0 before:hidden">{rows(group.archivedSessions, p)}</ul>
              </details>
            </li>
          )}
        </ul>
      </details>
    </li>
  );
}

/** 底部折叠段(已归档项目/已归档会话):开合态走旧 UI 契约键。 */
function FoldSection({
  label,
  foldKey,
  children,
}: {
  label: string;
  foldKey: "mc.archivedOpen" | "mc.projectArchiveOpen";
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => readFold(foldKey));
  return (
    <li>
      <details
        open={open}
        onToggle={(e) => {
          const next = (e.target as HTMLDetailsElement).open;
          setOpen(next);
          writeFold(foldKey, next);
        }}
      >
        <summary className="text-xs text-base-content/50">{label}</summary>
        <ul className="min-w-0 before:hidden">{children}</ul>
      </details>
    </li>
  );
}

function EmptySlate({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
      {icon}
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-base-content/60">{detail}</div>
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
  /** 后台提醒未读的会话 id 集(D3):命中行状态点转警示色 + 行高亮 */
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
  const [order, setOrder] = useState<string[]>(readProjectOrder);
  const [archivedProjects, setArchivedProjects] = useState<Set<string>>(readArchivedProjects);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedGroups);
  const [sessionArchOpen, setSessionArchOpen] = useState<Set<string>>(readSessionArchivesOpen);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const p: RowPlumbing = {
    currentId,
    actions,
    attentionIds,
    renamingId,
    onRenameStart: setRenamingId,
    onRenameEnd: () => setRenamingId(null),
  };

  const toggleCollapsed = (key: string, open: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(key);
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

  const body = () => {
    if (space === "cloud") {
      return (
        <CloudTaskList
          currentId={cloud?.currentId ?? null}
          onSelect={(task) => cloud?.onSelect(task)}
          reloadKey={cloud?.reloadKey ?? 0}
          onDeleted={cloud?.onDeleted}
        />
      );
    }

    const pool = sessions.filter((m) => (space === "chat" ? m.kind === "chat" : m.kind !== "chat"));
    if (pool.length === 0) {
      const chat = space === "chat";
      const EmptyIcon = chat ? MessagesSquare : Inbox;
      return (
        <EmptySlate
          icon={<EmptyIcon size={20} strokeWidth={1.75} className="text-base-content/30" aria-hidden />}
          title={t(chat ? "sidebar.empty.chat.title" : "sidebar.empty.local.title")}
          detail={t(chat ? "sidebar.empty.chat.detail" : "sidebar.empty.local.detail")}
        />
      );
    }

    if (space === "chat") {
      const active = pool.filter((m) => !m.archived);
      const archived = pool.filter((m) => m.archived);
      return (
        <ul className="menu menu-sm w-full flex-nowrap p-0">
          {rows(active, p)}
          {archived.length > 0 && (
            <FoldSection label={t("sidebar.archivedChats", { n: String(archived.length) })} foldKey="mc.archivedOpen">
              {rows(archived, p)}
            </FoldSection>
          )}
        </ul>
      );
    }

    const grouped = groupSessions(pool, order, archivedProjects);
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
      <ul className="menu menu-sm w-full flex-nowrap p-0">
        {grouped.projects.map((group) => (
          <ProjectDetails
            key={group.key}
            group={group}
            p={p}
            collapsed={collapsed.has(group.key)}
            onToggleCollapsed={toggleCollapsed}
            archOpen={sessionArchOpen.has(group.key)}
            onToggleArchOpen={toggleSessionArchOpen}
            onProjectArchiveToggle={toggleProjectArchive}
            archivedProject={false}
            drag={drag}
            dropTarget={dragOverKey === group.key && draggedKey !== null && draggedKey !== group.key}
          />
        ))}
        {grouped.archivedProjects.length > 0 && (
          <FoldSection
            label={t("sidebar.archivedProjects", { n: String(grouped.archivedProjects.length) })}
            foldKey="mc.projectArchiveOpen"
          >
            {grouped.archivedProjects.map((group) => (
              <ProjectDetails
                key={group.key}
                group={group}
                p={p}
                collapsed={collapsed.has(group.key)}
                onToggleCollapsed={toggleCollapsed}
                archOpen={sessionArchOpen.has(group.key)}
                onToggleArchOpen={toggleSessionArchOpen}
                onProjectArchiveToggle={toggleProjectArchive}
                archivedProject
              />
            ))}
          </FoldSection>
        )}
      </ul>
    );
  };

  return (
    <aside aria-label={t("sidebar.label")} className="flex w-side shrink-0 flex-col border-e border-base-300 bg-base-200">
      {/* 列头部:与 rail 角落/主区视图头部同一 h-13(52px)基线;空白处可拖拽窗口 */}
      <div data-tauri-drag-region="" className="flex h-13 shrink-0 items-center gap-1.5 border-b border-base-300 px-3">
        <Brand logo />
        <span data-tauri-drag-region="" className="min-w-0 flex-1" />
        {space === "cloud" && cloud?.onRefresh && (
          <button
            type="button"
            aria-label={t("cloud.list.refresh")}
            title={t("cloud.list.refresh")}
            className="btn btn-ghost btn-square btn-xs"
            onClick={cloud.onRefresh}
          >
            <RefreshCw size={13} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        <button
          type="button"
          aria-label={t("sidebar.newTask")}
          title={t("sidebar.newTask")}
          className="btn btn-primary btn-square btn-xs"
          onClick={actions.onNewTask}
        >
          <Plus size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
      {/* 三段式(LAYOUT.md):头部固定 → 列表 = 唯一滚动区 → footer 钉底 */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2">{body()}</div>
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
  // 安装失败:忙态已由 useUpdate 复位,这里换错误形态外显原因,按钮可重试
  return (
    <div
      role={error ? "alert" : "status"}
      className={`alert ${error ? "alert-error" : ""} alert-soft m-2 mt-0 flex items-center py-1.5 text-xs`}
    >
      <span className="min-w-0 flex-1 truncate" title={error ?? undefined}>
        {error ? t("update.failed", { reason: error }) : t("update.available", { version: update.latest ?? "" })}
      </span>
      <button type="button" className={`btn ${error ? "btn-error" : "btn-primary"} btn-xs`} disabled={installing} onClick={install}>
        {installing && <span className="loading loading-spinner loading-xs" aria-hidden />}
        {t("update.install")}
      </button>
    </div>
  );
}
