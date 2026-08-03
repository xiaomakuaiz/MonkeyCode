// 侧栏:三空间(本地/云端/对话)+ 会话列表。
// daisyUI 原生形态:menu(嵌套 details 折叠)、dropdown 行操作、status 状态点、
// badge 计数、input 搜索。项目拖拽排序用 HTML5 draggable(落点计算在
// lib/util/projects::reorderKeys,纯函数可测)。
import { useState, type DragEvent } from "react";

import { CloudTaskList } from "@/features/cloud/CloudTaskList";
import { useUpdate } from "@/features/update/useUpdate";
import { useI18n } from "@/lib/i18n";
import type { SessionMeta } from "@/lib/ipc/sessions";
import {
  groupSessions,
  readArchivedProjects,
  readCollapsedGroups,
  readProjectOrder,
  reorderKeys,
  writeArchivedProjects,
  writeCollapsedGroups,
  writeProjectOrder,
  type ProjectGroup,
} from "@/lib/util/projects";
import type { Space } from "@/lib/util/prefs";

export interface SidebarActions {
  onSelect: (meta: SessionMeta) => void;
  onDelete: (meta: SessionMeta) => void;
  onToggleArchive: (meta: SessionMeta) => void;
  onNewTask: () => void;
}

function StatusDot({ meta, attention }: { meta: SessionMeta; attention?: boolean }) {
  if (meta.waiting_ask) return <span aria-hidden className="status status-warning animate-pulse" />;
  // 后台提醒未读(D3):终态也用警示色点出来,点开行即消
  if (attention) return <span aria-hidden className="status status-warning" />;
  if (meta.status === "running") return <span aria-hidden className="status status-primary animate-pulse" />;
  if (meta.status === "error") return <span aria-hidden className="status status-error" />;
  return <span aria-hidden className="status opacity-30" />;
}

function RowMenu({ meta, actions }: { meta: SessionMeta; actions: SidebarActions }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="dropdown dropdown-end" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        tabIndex={0}
        aria-label={t("sidebar.row.menu")}
        className="btn btn-ghost btn-square btn-xs opacity-0 group-hover:opacity-100 focus:opacity-100"
        onBlur={() => setConfirming(false)}
      >
        ⋯
      </button>
      <ul className="dropdown-content menu menu-sm z-10 w-40 rounded-box border border-base-300 bg-base-100 shadow-md">
        <li>
          <button type="button" onClick={() => actions.onToggleArchive(meta)}>
            {meta.archived ? t("sidebar.row.unarchive") : t("sidebar.row.archive")}
          </button>
        </li>
        <li>
          <button
            type="button"
            className="text-error"
            onClick={(e) => {
              // 危险动作二段确认:第一次点变文案,再点才删
              if (!confirming) {
                e.preventDefault();
                setConfirming(true);
                return;
              }
              setConfirming(false);
              actions.onDelete(meta);
            }}
          >
            {confirming ? t("sidebar.row.deleteConfirm") : t("sidebar.row.delete")}
          </button>
        </li>
      </ul>
    </div>
  );
}

function SessionRow({
  meta,
  currentId,
  actions,
  attention,
}: {
  meta: SessionMeta;
  currentId: string | null;
  actions: SidebarActions;
  attention?: boolean;
}) {
  return (
    <li>
      <a
        className={`group flex items-center gap-2 ${meta.id === currentId ? "menu-active" : ""}${attention ? " bg-warning/10" : ""}`}
        data-attention={attention ? "" : undefined}
        onClick={() => actions.onSelect(meta)}
      >
        <StatusDot meta={meta} attention={attention} />
        <span className="min-w-0 flex-1 truncate">{meta.summary && meta.kind === "chat" ? meta.summary : meta.title}</span>
        <RowMenu meta={meta} actions={actions} />
      </a>
    </li>
  );
}

function ProjectDetails({
  group,
  currentId,
  actions,
  attentionIds,
  collapsed,
  onToggleCollapsed,
  onProjectArchiveToggle,
  archivedProject,
  drag,
}: {
  group: ProjectGroup;
  currentId: string | null;
  actions: SidebarActions;
  attentionIds?: Set<string>;
  collapsed: boolean;
  onToggleCollapsed: (key: string, open: boolean) => void;
  onProjectArchiveToggle: (key: string) => void;
  archivedProject: boolean;
  drag?: {
    onDragStart: (key: string) => void;
    onDropBefore: (key: string) => void;
  };
}) {
  const { t } = useI18n();
  const waiting = group.sessions.filter((s) => s.waiting_ask).length;
  return (
    <li>
      <details open={!collapsed} onToggle={(e) => onToggleCollapsed(group.key, (e.target as HTMLDetailsElement).open)}>
        <summary
          className="group"
          title={group.key}
          draggable={!!drag}
          onDragStart={() => drag?.onDragStart(group.key)}
          onDragOver={(e: DragEvent) => drag && e.preventDefault()}
          onDrop={(e: DragEvent) => {
            e.preventDefault();
            drag?.onDropBefore(group.key);
          }}
        >
          <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
          {waiting > 0 && <span className="badge badge-warning badge-xs">{waiting}</span>}
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
              className="btn btn-ghost btn-square btn-xs opacity-0 group-hover:opacity-100 focus:opacity-100"
            >
              ⋯
            </button>
            <ul className="dropdown-content menu menu-sm z-10 w-44 rounded-box border border-base-300 bg-base-100 shadow-md">
              <li>
                <button type="button" onClick={() => onProjectArchiveToggle(group.key)}>
                  {archivedProject ? t("sidebar.project.unarchive") : t("sidebar.project.archive")}
                </button>
              </li>
            </ul>
          </span>
        </summary>
        <ul>
          {group.sessions.map((meta) => (
            <SessionRow key={meta.id} meta={meta} currentId={currentId} actions={actions} attention={attentionIds?.has(meta.id)} />
          ))}
          {group.archivedSessions.length > 0 && (
            <li>
              <details>
                <summary className="text-base-content/50">
                  {t("sidebar.archived")}
                  <span className="badge badge-ghost badge-xs">{group.archivedSessions.length}</span>
                </summary>
                <ul>
                  {group.archivedSessions.map((meta) => (
                    <SessionRow key={meta.id} meta={meta} currentId={currentId} actions={actions} attention={attentionIds?.has(meta.id)} />
                  ))}
                </ul>
              </details>
            </li>
          )}
        </ul>
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

  const q = query.trim().toLowerCase();
  const matches = (m: SessionMeta) =>
    !q || m.title.toLowerCase().includes(q) || (m.summary ?? "").toLowerCase().includes(q) || m.workdir.toLowerCase().includes(q);

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
      return (
        <div className="flex flex-col items-center gap-1 px-3 py-8 text-center">
          <div className="text-sm font-semibold text-base-content/55">
            {empty ? t("sidebar.empty.title") : t("sidebar.noResults.title")}
          </div>
          <div className="text-xs text-base-content/40">
            {empty ? t("sidebar.empty.detail") : t("sidebar.noResults.detail")}
          </div>
        </div>
      );
    }

    if (space === "chat") {
      const active = pool.filter((m) => !m.archived);
      const archived = pool.filter((m) => m.archived);
      return (
        <ul className="menu menu-sm w-full p-0">
          {active.map((meta) => (
            <SessionRow key={meta.id} meta={meta} currentId={currentId} actions={actions} attention={attentionIds?.has(meta.id)} />
          ))}
          {archived.length > 0 && (
            <li>
              <details>
                <summary className="text-base-content/50">
                  {t("sidebar.archived")}
                  <span className="badge badge-ghost badge-xs">{archived.length}</span>
                </summary>
                <ul>
                  {archived.map((meta) => (
                    <SessionRow key={meta.id} meta={meta} currentId={currentId} actions={actions} attention={attentionIds?.has(meta.id)} />
                  ))}
                </ul>
              </details>
            </li>
          )}
        </ul>
      );
    }

    const grouped = groupSessions(pool, order, archivedProjects);
    const visibleKeys = grouped.projects.map((g) => g.key);
    const drag = {
      onDragStart: (key: string) => setDraggedKey(key),
      onDropBefore: (before: string) => {
        if (!draggedKey || draggedKey === before) return;
        const next = reorderKeys(visibleKeys, draggedKey, before);
        setOrder(next);
        writeProjectOrder(next);
        setDraggedKey(null);
      },
    };
    return (
      <ul className="menu menu-sm w-full p-0">
        {grouped.projects.map((group) => (
          <ProjectDetails
            key={group.key}
            group={group}
            currentId={currentId}
            actions={actions}
            attentionIds={attentionIds}
            collapsed={collapsed.has(group.key)}
            onToggleCollapsed={toggleCollapsed}
            onProjectArchiveToggle={toggleProjectArchive}
            archivedProject={false}
            drag={drag}
          />
        ))}
        {grouped.archivedProjects.length > 0 && (
          <li>
            <details>
              <summary className="text-base-content/50">
                {t("sidebar.archivedProjects")}
                <span className="badge badge-ghost badge-xs">{grouped.archivedProjects.length}</span>
              </summary>
              <ul>
                {grouped.archivedProjects.map((group) => (
                  <ProjectDetails
                    key={group.key}
                    group={group}
                    currentId={currentId}
                    actions={actions}
                    attentionIds={attentionIds}
                    collapsed={collapsed.has(group.key)}
                    onToggleCollapsed={toggleCollapsed}
                    onProjectArchiveToggle={toggleProjectArchive}
                    archivedProject
                  />
                ))}
              </ul>
            </details>
          </li>
        )}
      </ul>
    );
  };

  return (
    <aside aria-label={t("sidebar.label")} className="flex w-side shrink-0 flex-col gap-2 overflow-y-auto bg-base-200 p-2">
      <label className="input input-sm w-full">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="shrink-0 opacity-50" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          aria-label={t("sidebar.search")}
          placeholder={t("sidebar.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <button type="button" className="btn btn-primary btn-sm btn-block" onClick={actions.onNewTask}>
        {t("sidebar.newTask")}
      </button>
      <div className="min-h-0 flex-1">{body()}</div>
      <UpdateFooter />
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
      className={`alert ${error ? "alert-error" : "alert-info"} alert-soft flex items-center py-1.5 text-xs`}
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
