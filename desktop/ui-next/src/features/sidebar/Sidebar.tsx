// 侧栏:三空间(本地/云端/对话)+ 会话列表。
// 信息层级(设计定案见 LAYOUT.md §6):单行紧凑行——标题居左,右侧 meta 只在
// 要紧状态时给文字(等待审批/运行中/出错/已停止),空闲行留白不展示时间;
// hover/focus 时 meta 原位换出「…」菜单钮。归档统一沉到列表底部(不再
// details 套 details),折叠态用旧 UI 契约键持久化;搜索非空强制展开全部
// 折叠段。行与项目头支持右键菜单(contextMenu.openMenu),行内可重命名。
// daisyUI 原生形态:menu(details 折叠)、dropdown、status、badge、input。
import { Inbox, MoreHorizontal, Plus, Search, SearchX, X } from "lucide-react";
import { useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { RowDropdown } from "@/components/RowDropdown";
import { CloudTaskList } from "@/features/cloud/CloudTaskList";
import { Brand } from "@/features/titlebar/TitleBar";
import { useUpdate } from "@/features/update/useUpdate";
import { openMenu, type MenuItem } from "@/lib/contextMenu";
import { useI18n } from "@/lib/i18n";
import type { SessionMeta } from "@/lib/ipc/sessions";
import {
  groupSessions,
  projectName,
  readArchivedProjects,
  readCollapsedGroups,
  readProjectOrder,
  reorderKeys,
  writeArchivedProjects,
  writeCollapsedGroups,
  writeProjectOrder,
  type ProjectGroup,
} from "@/lib/util/projects";
import { readFold, writeFold, type FoldKey, type Space } from "@/lib/util/prefs";

export interface SidebarActions {
  onSelect: (meta: SessionMeta) => void;
  onDelete: (meta: SessionMeta) => void;
  onToggleArchive: (meta: SessionMeta) => void;
  onRename: (meta: SessionMeta, title: string) => void;
  onNewTask: () => void;
  /** 项目组头「在此项目新建任务」:预填该项目目录 */
  onNewTaskIn: (workdir: string) => void;
}

function StatusDot({ meta, attention }: { meta: SessionMeta; attention?: boolean }) {
  if (meta.waiting_ask) return <span aria-hidden className="status status-warning animate-pulse" />;
  // 后台提醒未读(D3):终态也用警示色点出来,点开行即消
  if (attention) return <span aria-hidden className="status status-warning" />;
  if (meta.status === "running") return <span aria-hidden className="status status-primary animate-pulse" />;
  if (meta.status === "error") return <span aria-hidden className="status status-error" />;
  return <span aria-hidden className="status opacity-30" />;
}

type T = ReturnType<typeof useI18n>["t"];

/** 行右侧 meta:只在要紧状态发声,空闲行留白(用户定案:不展示时间)。 */
function statusMeta(meta: SessionMeta, t: T): { text: string; cls: string } | null {
  if (meta.waiting_ask) return { text: t("status.waitingAsk"), cls: "text-warning" };
  if (meta.status === "running") return { text: t("status.running"), cls: "text-primary" };
  if (meta.status === "error") return { text: t("status.error"), cls: "text-error" };
  if (meta.status === "interrupted") return { text: t("status.interrupted"), cls: "text-base-content/50" };
  return null;
}

function SessionRow({
  meta,
  currentId,
  actions,
  attention,
  metaOverride,
  renaming,
  onRenameStart,
  onRenameEnd,
}: {
  meta: SessionMeta;
  currentId: string | null;
  actions: SidebarActions;
  attention?: boolean;
  /** 归档拍平区:meta 位显示项目名而非状态 */
  metaOverride?: string;
  renaming: boolean;
  onRenameStart: (id: string) => void;
  onRenameEnd: () => void;
}) {
  const { t } = useI18n();

  if (renaming) {
    const commit = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing) return; // IME 组字回车不提交
      if (e.key === "Escape") return onRenameEnd();
      if (e.key !== "Enter") return;
      const title = e.currentTarget.value.trim();
      if (title && title !== meta.title) actions.onRename(meta, title);
      onRenameEnd();
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
            onBlur={onRenameEnd}
          />
        </div>
      </li>
    );
  }

  const menuItems: MenuItem[] = [
    { label: t("sidebar.row.rename"), run: () => onRenameStart(meta.id) },
    {
      label: meta.archived ? t("sidebar.row.unarchive") : t("sidebar.row.archive"),
      run: () => actions.onToggleArchive(meta),
    },
    { label: t("sidebar.row.delete"), confirm: t("sidebar.row.deleteConfirm"), danger: true, run: () => actions.onDelete(meta) },
  ];
  const status = statusMeta(meta, t);
  const side = metaOverride ? { text: metaOverride, cls: "text-base-content/50" } : status;
  return (
    <li>
      <a
        className={`group flex min-h-8 items-center gap-2 transition-colors duration-150 ${meta.id === currentId ? "menu-active" : ""}${attention ? " bg-warning/10" : ""}`}
        data-attention={attention ? "" : undefined}
        onClick={() => actions.onSelect(meta)}
        onContextMenu={(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu({ x: e.clientX, y: e.clientY }, menuItems);
        }}
      >
        <StatusDot meta={meta} attention={attention} />
        <span className="min-w-0 flex-1 truncate">{meta.summary && meta.kind === "chat" ? meta.summary : meta.title}</span>
        {side && <span className={`shrink-0 text-xs ${side.cls} group-hover:hidden group-focus-within:hidden`}>{side.text}</span>}
        <RowDropdown label={t("sidebar.row.menu")} items={menuItems} />
      </a>
    </li>
  );
}

interface RowPlumbing {
  currentId: string | null;
  actions: SidebarActions;
  attentionIds?: Set<string>;
  renamingId: string | null;
  onRenameStart: (id: string) => void;
  onRenameEnd: () => void;
}

function rows(list: SessionMeta[], p: RowPlumbing, metaOverride?: (m: SessionMeta) => string) {
  return list.map((meta) => (
    <SessionRow
      key={meta.id}
      meta={meta}
      currentId={p.currentId}
      actions={p.actions}
      attention={p.attentionIds?.has(meta.id)}
      metaOverride={metaOverride?.(meta)}
      renaming={p.renamingId === meta.id}
      onRenameStart={p.onRenameStart}
      onRenameEnd={p.onRenameEnd}
    />
  ));
}

function ProjectDetails({
  group,
  plumbing,
  collapsed,
  forceOpen,
  onToggleCollapsed,
  onProjectArchiveToggle,
  archivedProject,
  drag,
  dropTarget,
}: {
  group: ProjectGroup;
  plumbing: RowPlumbing;
  collapsed: boolean;
  /** 搜索非空:强制展开且不写盘 */
  forceOpen: boolean;
  onToggleCollapsed: (key: string, open: boolean) => void;
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
  // 归档项目区不再嵌套「已归档」小节:活跃与归档会话合并平铺
  const list = archivedProject ? [...group.sessions, ...group.archivedSessions] : group.sessions;
  const menuItems: MenuItem[] = [
    ...(archivedProject ? [] : [{ label: t("sidebar.project.newTask"), run: () => plumbing.actions.onNewTaskIn(group.key) }]),
    {
      label: archivedProject ? t("sidebar.project.unarchive") : t("sidebar.project.archive"),
      run: () => onProjectArchiveToggle(group.key),
    },
  ];
  return (
    <li>
      <details
        open={forceOpen || !collapsed}
        onToggle={(e) => {
          if (forceOpen) return;
          onToggleCollapsed(group.key, (e.target as HTMLDetailsElement).open);
        }}
      >
        <summary
          className={`group ${dropTarget ? "border-t-2 border-primary" : ""}`}
          title={group.key}
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
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-base-content/70">{group.name}</span>
          {waiting > 0 && <span className="badge badge-warning badge-xs">{waiting}</span>}
          {!archivedProject && (
            <button
              type="button"
              aria-label={t("sidebar.project.newTask")}
              title={t("sidebar.project.newTask")}
              className="btn btn-ghost btn-square btn-xs hidden group-hover:inline-flex group-focus-within:inline-flex"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                plumbing.actions.onNewTaskIn(group.key);
              }}
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden />
            </button>
          )}
          <span
            className="dropdown dropdown-end"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <button
              type="button"
              tabIndex={0}
              aria-label={t("sidebar.project.menu")}
              className="btn btn-ghost btn-square btn-xs hidden group-hover:inline-flex group-focus-within:inline-flex"
            >
              <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
            </button>
            <ul className="dropdown-content menu menu-sm z-10 w-44 rounded-box bg-base-100 p-2 shadow-sm">
              <li>
                <button type="button" onClick={() => onProjectArchiveToggle(group.key)}>
                  {archivedProject ? t("sidebar.project.unarchive") : t("sidebar.project.archive")}
                </button>
              </li>
            </ul>
          </span>
        </summary>
        <ul>{rows(list, plumbing)}</ul>
      </details>
    </li>
  );
}

/** 底部折叠段(已归档/已归档项目):开合态走旧 UI 契约键;搜索时强制展开不写盘。 */
function FoldSection({
  label,
  count,
  foldKey,
  forceOpen,
  children,
}: {
  label: string;
  count: number;
  foldKey: FoldKey;
  forceOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => readFold(foldKey));
  return (
    <li>
      <details
        open={forceOpen || open}
        onToggle={(e) => {
          if (forceOpen) return;
          const next = (e.target as HTMLDetailsElement).open;
          setOpen(next);
          writeFold(foldKey, next);
        }}
      >
        <summary className="text-xs text-base-content/50">
          {label}
          <span className="badge badge-ghost badge-xs">{count}</span>
        </summary>
        <ul>{children}</ul>
      </details>
    </li>
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
  cloud?: { currentId: string | null; onSelect: (task: import("@/lib/ipc/cloudtasks").CloudTask) => void; reloadKey: number; onDeleted?: (id: string) => void };
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<string[]>(readProjectOrder);
  const [archivedProjects, setArchivedProjects] = useState<Set<string>>(readArchivedProjects);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedGroups);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const forceOpen = q !== "";
  const matches = (m: SessionMeta) =>
    !q || m.title.toLowerCase().includes(q) || (m.summary ?? "").toLowerCase().includes(q) || m.workdir.toLowerCase().includes(q);

  const plumbing: RowPlumbing = {
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
      return <CloudTaskList currentId={cloud?.currentId ?? null} onSelect={(task) => cloud?.onSelect(task)} reloadKey={cloud?.reloadKey ?? 0} onDeleted={cloud?.onDeleted} />;
    }

    const pool = sessions.filter((m) => (space === "chat" ? m.kind === "chat" : m.kind !== "chat")).filter(matches);
    if (pool.length === 0) {
      const empty = sessions.length === 0;
      const EmptyIcon = empty ? Inbox : SearchX;
      return (
        <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
          <EmptyIcon size={20} strokeWidth={1.75} className="text-base-content/30" aria-hidden />
          <div className="text-sm font-semibold">
            {empty ? t("sidebar.empty.title") : t("sidebar.noResults.title")}
          </div>
          <div className="text-xs text-base-content/60">
            {empty ? t("sidebar.empty.detail") : t("sidebar.noResults.detail")}
          </div>
          {empty && (
            <button type="button" className="btn btn-primary btn-xs mt-2" onClick={actions.onNewTask}>
              {t("sidebar.empty.cta")}
            </button>
          )}
        </div>
      );
    }

    if (space === "chat") {
      const active = pool.filter((m) => !m.archived);
      const archived = pool.filter((m) => m.archived);
      return (
        <ul className="menu menu-sm w-full p-0">
          {rows(active, plumbing)}
          {archived.length > 0 && (
            <FoldSection label={t("sidebar.archived")} count={archived.length} foldKey="mc.archivedOpen" forceOpen={forceOpen}>
              {rows(archived, plumbing)}
            </FoldSection>
          )}
        </ul>
      );
    }

    const grouped = groupSessions(pool, order, archivedProjects);
    // 会话全归档的项目不留空组头:它的行都在底部「已归档」区
    const activeProjects = grouped.projects.filter((g) => g.sessions.length > 0);
    const visibleKeys = activeProjects.map((g) => g.key);
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
    // 归档会话拍平到底部(meta 位给项目名);归档项目单独一段
    const archivedFlat = grouped.projects.flatMap((g) => g.archivedSessions);
    return (
      <ul className="menu menu-sm w-full p-0">
        {activeProjects.map((group) => (
          <ProjectDetails
            key={group.key}
            group={group}
            plumbing={plumbing}
            collapsed={collapsed.has(group.key)}
            forceOpen={forceOpen}
            onToggleCollapsed={toggleCollapsed}
            onProjectArchiveToggle={toggleProjectArchive}
            archivedProject={false}
            drag={drag}
            dropTarget={dragOverKey === group.key && draggedKey !== null && draggedKey !== group.key}
          />
        ))}
        {archivedFlat.length > 0 && (
          <FoldSection label={t("sidebar.archived")} count={archivedFlat.length} foldKey="mc.archivedOpen" forceOpen={forceOpen}>
            {rows(archivedFlat, plumbing, (m) => projectName(m.workdir))}
          </FoldSection>
        )}
        {grouped.archivedProjects.length > 0 && (
          <FoldSection
            label={t("sidebar.archivedProjects")}
            count={grouped.archivedProjects.length}
            foldKey="mc.projectArchiveOpen"
            forceOpen={forceOpen}
          >
            {grouped.archivedProjects.map((group) => (
              <ProjectDetails
                key={group.key}
                group={group}
                plumbing={plumbing}
                collapsed={collapsed.has(group.key)}
                forceOpen={forceOpen}
                onToggleCollapsed={toggleCollapsed}
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
      {/* 列头部:与 rail 角落/主区视图头部同一 h-11 基线;空白处可拖拽窗口 */}
      <div data-tauri-drag-region="" className="flex h-11 shrink-0 items-center gap-1.5 border-b border-base-300 px-3">
        <Brand logo />
        <span data-tauri-drag-region="" className="min-w-0 flex-1" />
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
      {/* 四段式(LAYOUT.md):头部固定 → 搜索固定 → 列表 = 唯一滚动区 → footer 钉底 */}
      <div className="shrink-0 p-2 pb-1">
        <label className="input input-sm w-full">
          <Search size={14} strokeWidth={1.75} className="shrink-0 opacity-50" aria-hidden />
          <input
            type="search"
            aria-label={t("sidebar.search")}
            placeholder={t("sidebar.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query !== "" && (
            <button
              type="button"
              aria-label={t("sidebar.clearSearch")}
              className="btn btn-ghost btn-square btn-xs shrink-0"
              onClick={() => setQuery("")}
            >
              <X size={12} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2 pt-1">{body()}</div>
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
      className={`alert ${error ? "alert-error" : "alert-info"} alert-soft m-2 mt-0 flex items-center py-1.5 text-xs`}
    >
      <span className="min-w-0 flex-1 truncate" title={error ?? undefined}>
        {error ? t("update.failed", { reason: error }) : t("update.available", { version: update.latest ?? "" })}
      </span>
      <button type="button" className={`btn ${error ? "btn-error" : "btn-info"} btn-xs`} disabled={installing} onClick={install}>
        {installing && <span className="loading loading-spinner loading-xs" aria-hidden />}
        {t("update.install")}
      </button>
    </div>
  );
}
