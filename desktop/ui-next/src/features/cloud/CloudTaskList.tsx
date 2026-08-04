// 侧栏云端空间的任务列表:运行中(pending/processing)置顶平铺,项目按
// mc_projects 分组(daisyUI details 折叠,展开时按 project_id 懒拉任务;
// 无项目的快速任务归「快速开始」组),历史(finished/error)收进「云端历史」
// 折叠段并按页续拉。行菜单(dropdown)提供删除(二段确认);删除后触发
// 列表重拉,删的是当前打开任务时经 onDeleted 让上层清空。
// 导出组件与数据 hook,Sidebar 接线由 App 侧完成(本文件不触 features/sidebar)。
// daisyUI 原生形态:menu + details 折叠 + status 状态点 + badge 计数。
import { Cloud, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";
import { inDesktopShell } from "@/lib/ipc/ipc";
import { mcProjects, mcTaskDelete, mcTasks, type CloudProject, type CloudTask } from "@/lib/ipc/cloudtasks";

const PAGE_SIZE = 20;

const ACTIVE = new Set(["pending", "processing"]);

/** 「快速开始」组(无项目的快速任务)在懒拉缓存里的键。 */
const QUICK_KEY = "quick";

export interface CloudTasksFeed {
  /** null = 首屏加载中 */
  tasks: CloudTask[] | null;
  active: CloudTask[];
  history: CloudTask[];
  loading: boolean;
  error: string;
  hasMore: boolean;
  loadMore(): void;
  refresh(): void;
}

/** 云端任务列表数据源:分页合并,active/history 由状态派生。
 * reloadKey 变化触发整表重拉(App 在任务创建/终止后 bump)。 */
export function useCloudTasks(reloadKey = 0): CloudTasksFeed {
  const [tasks, setTasks] = useState<CloudTask[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  const pageRef = useRef(0); // 已加载的最后一页(0 = 尚未加载)
  const inFlight = useRef(false);

  const fetchPage = useCallback(async (page: number, replace: boolean) => {
    if (!inDesktopShell()) {
      // 浏览器模式:与 sessionsList 同约定,查询类降级为空列表而非报错
      setTasks((prev) => prev ?? []);
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError("");
    try {
      const r = await mcTasks(page, PAGE_SIZE);
      const batch = r.tasks ?? [];
      setTotal(r.page_info?.total ?? r.page_info?.total_count ?? null);
      pageRef.current = page;
      setTasks((prev) => {
        if (replace || !prev) return batch;
        // 续页去重:置顶任务状态翻转会跨页重复出现
        const seen = new Set(prev.map((task) => task.id));
        return [...prev, ...batch.filter((task) => !seen.has(task.id))];
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPage(1, true);
  }, [fetchPage, reloadKey]);

  const loaded = tasks?.length ?? 0;
  const hasMore = total !== null ? loaded < total : loaded >= pageRef.current * PAGE_SIZE && loaded > 0;

  return {
    tasks,
    active: (tasks ?? []).filter((task) => ACTIVE.has(task.status ?? "")),
    history: (tasks ?? []).filter((task) => !ACTIVE.has(task.status ?? "")),
    loading,
    error,
    hasMore,
    loadMore: () => void fetchPage(pageRef.current + 1, false),
    refresh: () => void fetchPage(1, true),
  };
}

/** 项目列表(mc_projects;每项目捎带 ≤3 条运行中任务)。失败降级为空
 * (列表退回平铺形态,任务本身不受影响),但必须留痕便于诊断。 */
export function useCloudProjects(reloadKey = 0): CloudProject[] {
  const [projects, setProjects] = useState<CloudProject[]>([]);
  useEffect(() => {
    if (!inDesktopShell()) return;
    let alive = true;
    mcProjects()
      .then((r) => {
        if (alive) setProjects((r.projects ?? []).filter((p) => !!p.id));
      })
      .catch((e: unknown) => {
        console.warn("[cloud-projects] 项目列表拉取失败:", e);
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);
  return projects;
}

export function cloudTaskLabel(task: CloudTask, fallback: string): string {
  return task.title || task.summary || task.content || fallback;
}

function StatusDot({ status }: { status?: string }) {
  if (status === "processing") return <span aria-hidden className="status status-primary animate-pulse" />;
  if (status === "pending") return <span aria-hidden className="status status-warning animate-pulse" />;
  if (status === "error") return <span aria-hidden className="status status-error" />;
  return <span aria-hidden className="status opacity-30" />;
}

function RowMenu({ task, onDelete }: { task: CloudTask; onDelete: (task: CloudTask) => void }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="dropdown dropdown-end" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        tabIndex={0}
        aria-label={t("cloud.list.menu")}
        className="btn btn-ghost btn-square btn-xs opacity-0 group-hover:opacity-100 focus:opacity-100"
        onBlur={() => setConfirming(false)}
      >
        <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <ul className="dropdown-content menu menu-sm z-10 w-40 rounded-box bg-base-100 p-2 shadow-sm">
        <li>
          <button
            type="button"
            className="text-error"
            onClick={(e) => {
              // 危险动作二段确认:第一次点变文案,再点才删(与本地侧栏同款)
              if (!confirming) {
                e.preventDefault();
                setConfirming(true);
                return;
              }
              setConfirming(false);
              onDelete(task);
            }}
          >
            {confirming ? t("cloud.list.deleteConfirm") : t("cloud.list.delete")}
          </button>
        </li>
      </ul>
    </div>
  );
}

function TaskRow({
  task,
  currentId,
  onSelect,
  onDelete,
}: {
  task: CloudTask;
  currentId: string | null;
  onSelect: (task: CloudTask) => void;
  onDelete: (task: CloudTask) => void;
}) {
  const { t } = useI18n();
  return (
    <li>
      <a
        className={`group flex min-h-8 items-center gap-2 transition-colors duration-150 ${task.id === currentId ? "menu-active" : ""}`}
        onClick={() => onSelect(task)}
      >
        <StatusDot status={task.status} />
        <span className="min-w-0 flex-1 truncate">{cloudTaskLabel(task, t("cloud.list.untitled"))}</span>
        <RowMenu task={task} onDelete={onDelete} />
      </a>
    </li>
  );
}

/** 分组懒拉三态(互斥;都缺省 = 还没拉过,展开时才拉)。 */
interface GroupTasksState {
  loading?: boolean;
  tasks?: CloudTask[];
  error?: string;
}

/** 项目/快速开始分组:details 折叠,展开时懒拉该组任务(捎带的 ≤3 条运行
 * 中任务只做 summary 徽标——它们已置顶平铺,组内以懒拉结果为准)。 */
function TaskGroup({
  label,
  running,
  state,
  onOpen,
  currentId,
  onSelect,
  onDelete,
}: {
  label: string;
  running: number;
  state?: GroupTasksState;
  onOpen: () => void;
  currentId: string | null;
  onSelect: (task: CloudTask) => void;
  onDelete: (task: CloudTask) => void;
}) {
  const { t } = useI18n();
  return (
    <li>
      <details
        onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open) onOpen();
        }}
      >
        <summary title={label}>
          {/* 项目分组头 = 微标签档(与本地侧栏同语言) */}
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wider text-base-content/45 uppercase">{label}</span>
          {running > 0 && <span className="badge badge-primary badge-xs">{running}</span>}
        </summary>
        <ul>
          {state?.loading && (
            <li className="flex justify-center py-2">
              <span className="loading loading-spinner loading-xs text-base-content/40" aria-label={t("cloud.list.loading")} />
            </li>
          )}
          {state?.error && (
            <li className="px-2 py-1 text-[11px] text-error">{t("cloud.list.groupError", { reason: state.error })}</li>
          )}
          {state?.tasks && state.tasks.length === 0 && (
            <li className="px-2 py-1 text-[11px] text-base-content/40">{t("cloud.list.groupEmpty")}</li>
          )}
          {state?.tasks?.map((task) => (
            <TaskRow key={task.id} task={task} currentId={currentId} onSelect={onSelect} onDelete={onDelete} />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function CloudTaskList({
  currentId,
  onSelect,
  reloadKey = 0,
  onDeleted,
}: {
  currentId: string | null;
  onSelect: (task: CloudTask) => void;
  /** App 在任务创建/终止后 bump,触发整表重拉 */
  reloadKey?: number;
  /** 任务删除成功后回调(带任务 id);App 据此清空当前打开的同 id 视图 */
  onDeleted?: (id: string) => void;
}) {
  const { t } = useI18n();
  const feed = useCloudTasks(reloadKey);
  const projects = useCloudProjects(reloadKey);

  // 分组懒拉缓存(键 = 项目 id / QUICK_KEY);重拉键翻转即作废
  const [groupTasks, setGroupTasks] = useState<Record<string, GroupTasksState>>({});
  useEffect(() => setGroupTasks({}), [reloadKey]);
  const [deleteErr, setDeleteErr] = useState("");

  const loadGroup = (key: string, projectId: string | null) => {
    if (groupTasks[key]) return; // 拉过/在途
    setGroupTasks((prev) => ({ ...prev, [key]: { loading: true } }));
    mcTasks(1, PAGE_SIZE, "", projectId ? { projectId } : { quickStart: true })
      .then((r) => setGroupTasks((prev) => ({ ...prev, [key]: { tasks: r.tasks ?? [] } })))
      .catch((e: unknown) =>
        setGroupTasks((prev) => ({ ...prev, [key]: { error: e instanceof Error ? e.message : String(e) } })),
      );
  };

  const handleDelete = (task: CloudTask) => {
    setDeleteErr("");
    void mcTaskDelete(task.id)
      .then(() => {
        // 分组缓存就地剔除(展开着的组不必等重拉),整表重拉刷新置顶/历史
        setGroupTasks((prev) => {
          const next: Record<string, GroupTasksState> = {};
          for (const [key, state] of Object.entries(prev)) {
            next[key] = state.tasks ? { ...state, tasks: state.tasks.filter((x) => x.id !== task.id) } : state;
          }
          return next;
        });
        feed.refresh();
        onDeleted?.(task.id);
      })
      .catch((e: unknown) => {
        // 服务端会拒绝仍在运行/虚拟机尚在线的任务:原因外显,不静默
        setDeleteErr(e instanceof Error ? e.message : String(e));
      });
  };

  if (feed.tasks === null) {
    return feed.error ? (
      <div role="alert" className="alert alert-error alert-soft flex flex-col items-start gap-1 py-2 text-xs">
        <span className="break-all">{t("cloud.list.error", { reason: feed.error })}</span>
        <button type="button" className="btn btn-ghost btn-xs" onClick={feed.refresh}>
          {t("cloud.list.retry")}
        </button>
      </div>
    ) : (
      <div className="flex justify-center py-6">
        <span className="loading loading-spinner loading-sm text-base-content/40" aria-label={t("cloud.list.loading")} />
      </div>
    );
  }

  if (feed.tasks.length === 0 && projects.length === 0) {
    // 空态统一形态:图标 + 标题档 + 辅助档,居中
    return (
      <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
        <Cloud size={20} strokeWidth={1.75} className="text-base-content/30" aria-hidden />
        <div className="text-sm font-semibold">{t("cloud.list.empty.title")}</div>
        <div className="text-xs text-base-content/60">{t("cloud.list.empty.detail")}</div>
      </div>
    );
  }

  return (
    <ul className="menu menu-sm w-full p-0">
      {feed.active.map((task) => (
        <TaskRow key={task.id} task={task} currentId={currentId} onSelect={onSelect} onDelete={handleDelete} />
      ))}
      {projects.map((project) => (
        <TaskGroup
          key={project.id}
          label={project.name || project.full_name || t("cloud.list.untitledProject")}
          running={(project.tasks ?? []).length}
          state={groupTasks[project.id ?? ""]}
          onOpen={() => loadGroup(project.id ?? "", project.id ?? null)}
          currentId={currentId}
          onSelect={onSelect}
          onDelete={handleDelete}
        />
      ))}
      {projects.length > 0 && (
        <TaskGroup
          label={t("cloud.list.quickStart")}
          running={0}
          state={groupTasks[QUICK_KEY]}
          onOpen={() => loadGroup(QUICK_KEY, null)}
          currentId={currentId}
          onSelect={onSelect}
          onDelete={handleDelete}
        />
      )}
      {feed.history.length > 0 && (
        <li>
          <details open={feed.active.length === 0 && projects.length === 0}>
            <summary className="text-[11px] text-base-content/40">
              {t("cloud.list.history")}
              <span className="badge badge-ghost badge-xs">{feed.history.length}</span>
            </summary>
            <ul>
              {feed.history.map((task) => (
                <TaskRow key={task.id} task={task} currentId={currentId} onSelect={onSelect} onDelete={handleDelete} />
              ))}
              {feed.hasMore && (
                <li>
                  <button type="button" className="text-base-content/50" disabled={feed.loading} onClick={feed.loadMore}>
                    {feed.loading && <span className="loading loading-spinner loading-xs" aria-hidden />}
                    {t("cloud.list.loadMore")}
                  </button>
                </li>
              )}
            </ul>
          </details>
        </li>
      )}
      {deleteErr && (
        <li className="px-2 py-1 text-[11px] text-error">{t("cloud.list.deleteFailed", { reason: deleteErr })}</li>
      )}
      {feed.error && (
        <li className="px-2 py-1 text-[11px] text-error">{t("cloud.list.error", { reason: feed.error })}</li>
      )}
    </ul>
  );
}
