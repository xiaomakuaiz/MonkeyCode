// 侧栏云端空间的任务列表。信息布局参考旧 UI(进行中区 / 「历史任务 · N」
// 小节 / 「项目」区懒拉分组 + 快速开始),组件一律 daisyUI 原生形态:
// menu(menu-title 区标签、details 折叠)、status 状态点、loading。
// 行 = 单行(安静行同构,定案 2026-08-04):标题 + 尾注(仅要紧态着色;
// 终态无点无尾注,状态词进 tooltip);行菜单 = 右键
// (终止任务仅运行中 / 删除,均二段确认)。历史开合态持久化
// mc.cloudHistoryOpen(旧 UI 契约键);query 非空过滤并强制展开(未拉过
// 的组顺势懒拉)。导出组件与数据 hook,Sidebar 接线由 App 侧完成。
import { Cloud, Folder } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import { openMenu, type MenuItem } from "@/lib/contextMenu";
import { useI18n } from "@/lib/i18n";
import { inDesktopShell } from "@/lib/ipc/ipc";
import { mcProjects, mcTaskDelete, mcTasks, mcTaskStop, type CloudProject, type CloudTask } from "@/lib/ipc/cloudtasks";
import { readFold, writeFold } from "@/lib/util/prefs";

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
  total: number | null;
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
    total,
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

type T = ReturnType<typeof useI18n>["t"];

/** 行状态尾注(安静行同构):仅要紧态给着色词,终态无尾注(状态词进 tooltip)。 */
function cloudState(status: string | undefined, t: T): { text: string; cls: string } | null {
  switch (status) {
    case "pending":
      return { text: t("cloud.status.pending"), cls: "text-warning" };
    case "processing":
      return { text: t("cloud.status.processing"), cls: "text-primary" };
    case "error":
      return { text: t("cloud.status.error"), cls: "text-error" };
    default:
      return null;
  }
}

function StatusDot({ status }: { status?: string }) {
  if (status === "processing") return <span aria-hidden className="status status-primary animate-pulse" />;
  if (status === "pending") return <span aria-hidden className="status status-warning animate-pulse" />;
  if (status === "error") return <span aria-hidden className="status status-error" />;
  // 终态行:状态槽只占位不显形(与本地行同构)
  return <span aria-hidden className="status invisible" />;
}

function TaskRow({
  task,
  currentId,
  onSelect,
  onDelete,
  onStop,
}: {
  task: CloudTask;
  currentId: string | null;
  onSelect: (task: CloudTask) => void;
  onDelete: (task: CloudTask) => void;
  onStop: (task: CloudTask) => void;
}) {
  const { t } = useI18n();
  const label = cloudTaskLabel(task, t("cloud.list.untitled"));
  const st = cloudState(task.status, t);
  // tooltip 保留状态词:尾注被安静掉的终态在这里仍可查
  const stateWord = st?.text ?? (task.status === "finished" ? t("cloud.status.finished") : "");
  const running = ACTIVE.has(task.status ?? "");
  const menuItems: MenuItem[] = [
    ...(running ? [{ label: t("cloud.view.stop"), confirm: t("cloud.view.stopConfirm"), danger: true, run: () => onStop(task) }] : []),
    { label: t("cloud.list.delete"), confirm: t("cloud.list.deleteConfirm"), danger: true, run: () => onDelete(task) },
  ];
  return (
    <li>
      <a
        className={`flex min-h-8 min-w-0 items-center gap-2 overflow-hidden transition-colors duration-150 ${task.id === currentId ? "menu-active" : ""}`}
        title={`${label}\n${stateWord ? `${stateWord}\n` : ""}${t("sidebar.row.hint")}`}
        onClick={() => onSelect(task)}
        onContextMenu={(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu({ x: e.clientX, y: e.clientY }, menuItems);
        }}
      >
        <StatusDot status={task.status} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {st && <span className={`max-w-16 shrink-0 truncate text-xs ${st.cls}`}>{st.text}</span>}
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

export function CloudTaskList({
  currentId,
  onSelect,
  reloadKey = 0,
  onDeleted,
  query = "",
}: {
  currentId: string | null;
  onSelect: (task: CloudTask) => void;
  /** App 在任务创建/终止后 bump,触发整表重拉 */
  reloadKey?: number;
  /** 任务删除成功后回调(带任务 id);App 据此清空当前打开的同 id 视图 */
  onDeleted?: (id: string) => void;
  /** 侧栏搜索词(已 trim/lowercase);非空时过滤行并强制展开折叠段 */
  query?: string;
}) {
  const { t } = useI18n();
  const feed = useCloudTasks(reloadKey);
  const projects = useCloudProjects(reloadKey);
  const forceOpen = query !== "";

  // 分组懒拉缓存(键 = 项目 id / QUICK_KEY);重拉键翻转即作废
  const [groupTasks, setGroupTasks] = useState<Record<string, GroupTasksState>>({});
  useEffect(() => setGroupTasks({}), [reloadKey]);
  // 组开合;历史小节走旧 UI 契约键持久化
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState<boolean>(() => readFold("mc.cloudHistoryOpen"));
  // 行动作(删除/终止)失败原因,已格式化;新动作发起时清空
  const [actionErr, setActionErr] = useState("");

  const loadGroup = useCallback(
    (key: string, projectId: string | null) => {
      if (groupTasks[key]) return; // 拉过/在途
      setGroupTasks((prev) => ({ ...prev, [key]: { loading: true } }));
      mcTasks(1, PAGE_SIZE, "", projectId ? { projectId } : { quickStart: true })
        .then((r) => setGroupTasks((prev) => ({ ...prev, [key]: { tasks: r.tasks ?? [] } })))
        .catch((e: unknown) =>
          setGroupTasks((prev) => ({ ...prev, [key]: { error: e instanceof Error ? e.message : String(e) } })),
        );
    },
    [groupTasks],
  );

  // 搜索强制展开:未拉过的组顺势懒拉(命中不能藏在没拉过的组里)
  useEffect(() => {
    if (!forceOpen) return;
    for (const project of projects) loadGroup(project.id ?? "", project.id ?? null);
    if (projects.length > 0) loadGroup(QUICK_KEY, null);
  }, [forceOpen, projects, loadGroup]);

  const handleDelete = (task: CloudTask) => {
    setActionErr("");
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
        setActionErr(t("cloud.list.deleteFailed", { reason: e instanceof Error ? e.message : String(e) }));
      });
  };

  const handleStop = (task: CloudTask) => {
    setActionErr("");
    void mcTaskStop(task.id)
      .then(() => {
        // 状态翻转(active→history),分组缓存作废,整表重拉
        setGroupTasks({});
        feed.refresh();
      })
      .catch((e: unknown) => {
        setActionErr(t("cloud.err.stopFailed", { reason: e instanceof Error ? e.message : String(e) }));
      });
  };

  const hit = (task: CloudTask) => !query || cloudTaskLabel(task, "").toLowerCase().includes(query);

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

  const activeRows = feed.active.filter(hit);
  const historyRows = feed.history.filter(hit);

  const groupBody = (key: string) => {
    const state = groupTasks[key];
    const rowsHit = (state?.tasks ?? []).filter(hit);
    return (
      // 缩进进行内、行底满宽(与本地组同构,2026-08-05 定案):组内行 ps-6
      <ul className="ms-0 min-w-0 ps-0 before:hidden [&>li>a]:ps-6">
        {state?.loading && (
          <li className="flex justify-center py-2">
            <span className="loading loading-spinner loading-xs text-base-content/40" aria-label={t("cloud.list.loading")} />
          </li>
        )}
        {state?.error && <li className="px-2 py-1 text-xs text-warning">{t("cloud.list.groupError", { reason: state.error })}</li>}
        {state?.tasks && rowsHit.length === 0 && (
          <li className="px-2 py-1 text-xs text-base-content/40">{t("cloud.list.groupEmpty")}</li>
        )}
        {rowsHit.map((task) => (
          <TaskRow key={task.id} task={task} currentId={currentId} onSelect={onSelect} onDelete={handleDelete} onStop={handleStop} />
        ))}
      </ul>
    );
  };

  const projectGroup = (key: string, name: string, projectId: string | null) => {
    const isOpen = forceOpen || openGroups.has(key);
    return (
    <li key={key} className="mt-1 first:mt-0">
      <details
        open={isOpen}
        onToggle={(e) => {
          if (forceOpen) return;
          const open = (e.target as HTMLDetailsElement).open;
          setOpenGroups((prev) => {
            if (open === prev.has(key)) return prev;
            const next = new Set(prev);
            if (open) next.add(key);
            else next.delete(key);
            return next;
          });
          if (open) loadGroup(key, projectId);
        }}
      >
        {/* 区块标签形态(与本地组头同构):无图标、无折叠箭头,开合只靠点击组头 */}
        <summary title={name} className="flex items-center after:hidden">
          <Folder size={12} strokeWidth={1.75} className="shrink-0 text-base-content/40" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-base-content/50">
            {name}
          </span>
        </summary>
        {groupBody(key)}
      </details>
    </li>
    );
  };

  return (
    <ul className="menu menu-sm w-full flex-nowrap p-0 [&_li]:flex-nowrap">
      {activeRows.length > 0 && (
        <>
          <li className="menu-title">{t("cloud.list.active")}</li>
          {activeRows.map((task) => (
            <TaskRow key={task.id} task={task} currentId={currentId} onSelect={onSelect} onDelete={handleDelete} onStop={handleStop} />
          ))}
        </>
      )}
      {historyRows.length > 0 && (
        <li>
          <details
            open={forceOpen || historyOpen}
            onToggle={(e) => {
              if (forceOpen) return;
              const next = (e.target as HTMLDetailsElement).open;
              if (next === historyOpen) return;
              setHistoryOpen(next);
              writeFold("mc.cloudHistoryOpen", next);
            }}
          >
            <summary className="text-xs text-base-content/50">{t("cloud.list.history", { n: String(feed.history.length) })}</summary>
            <ul className="min-w-0 before:hidden">
              {historyRows.map((task) => (
                <TaskRow key={task.id} task={task} currentId={currentId} onSelect={onSelect} onDelete={handleDelete} onStop={handleStop} />
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
      {projects.length > 0 && (
        <>
          <li className="menu-title">{t("cloud.list.projects")}</li>
          {projects.map((project) =>
            projectGroup(project.id ?? "", project.name || project.full_name || t("cloud.list.untitledProject"), project.id ?? null),
          )}
          {projectGroup(QUICK_KEY, t("cloud.list.quickStart"), null)}
        </>
      )}
      {actionErr && <li className="px-2 py-1 text-xs text-error">{actionErr}</li>}
      {feed.error && <li className="px-2 py-1 text-xs text-error">{t("cloud.list.error", { reason: feed.error })}</li>}
    </ul>
  );
}
