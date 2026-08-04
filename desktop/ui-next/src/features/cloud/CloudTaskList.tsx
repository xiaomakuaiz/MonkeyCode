// 侧栏云端空间的任务列表。设计基线 = 旧 UI 云端面板:
// - 「进行中」区平铺 pending/processing;「项目」区按 mc_projects 分组
//   (文件夹组头,展开懒拉;无项目的快速任务归「快速开始」);
//   「历史任务 · N」小节收 finished/error,按页续拉,开合态持久化
//   (mc.cloudHistoryOpen 旧 UI 契约键)
// - 行 = 单行 34px:标题 + 状态尾注(10.5px;运行/出错带 6px 状态点,
//   已完成低调);行菜单 = 右键(终止任务仅运行中 / 删除,均二段确认)
// - query 非空:按行文案过滤并强制展开全部折叠段(组懒拉照常触发)
// 导出组件与数据 hook,Sidebar 接线由 App 侧完成(本文件不触 features/sidebar)。
import { Cloud, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import { EmptyState, GroupHeader, SectionLabel } from "@/components/sidekit";
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

/** 行状态词(旧 UI CLOUD_STATUS):运行/出错着色,已完成低调。 */
function cloudState(status: string | undefined, t: T): { text: string; cls: string; dot: string; emphasize: boolean } {
  switch (status) {
    case "pending":
      return { text: t("cloud.status.pending"), cls: "text-warning", dot: "bg-warning", emphasize: true };
    case "processing":
      return { text: t("cloud.status.processing"), cls: "text-primary", dot: "bg-primary", emphasize: true };
    case "error":
      return { text: t("cloud.status.error"), cls: "text-error", dot: "bg-error", emphasize: true };
    case "finished":
      return { text: t("cloud.status.finished"), cls: "text-base-content/55", dot: "", emphasize: false };
    default:
      return { text: t("cloud.list.untitled"), cls: "text-base-content/45", dot: "", emphasize: false };
  }
}

function TaskRow({
  task,
  depth = 0,
  currentId,
  onSelect,
  onDelete,
  onStop,
}: {
  task: CloudTask;
  depth?: number;
  currentId: string | null;
  onSelect: (task: CloudTask) => void;
  onDelete: (task: CloudTask) => void;
  onStop: (task: CloudTask) => void;
}) {
  const { t } = useI18n();
  const label = cloudTaskLabel(task, t("cloud.list.untitled"));
  const st = cloudState(task.status, t);
  const running = ACTIVE.has(task.status ?? "");
  const active = task.id === currentId;
  const menuItems: MenuItem[] = [
    ...(running ? [{ label: t("cloud.view.stop"), confirm: t("cloud.view.stopConfirm"), danger: true, run: () => onStop(task) }] : []),
    { label: t("cloud.list.delete"), confirm: t("cloud.list.deleteConfirm"), danger: true, run: () => onDelete(task) },
  ];
  return (
    <div
      role="button"
      tabIndex={0}
      title={`${label}\n${st.text}\n${t("sidebar.row.hint")}`}
      className={`flex min-h-[34px] cursor-pointer items-center gap-[7px] rounded-[7px] pe-2 ${
        active ? "bg-primary/10" : "hover:bg-base-content/5"
      }`}
      style={{ paddingInlineStart: 11 + Math.max(0, depth) * 14 }}
      onClick={() => onSelect(task)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(task);
        }
      }}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu({ x: e.clientX, y: e.clientY }, menuItems);
      }}
    >
      <span className={`min-w-0 flex-1 truncate text-[12.5px] leading-[1.35] ${active ? "text-base-content" : "text-base-content/90"}`}>
        {label}
      </span>
      <span className="flex flex-none items-center gap-[5px]">
        {st.emphasize && <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${st.dot}`} />}
        <span className={`max-w-[60px] truncate text-[10.5px] leading-[1.2] ${active ? "text-primary/60" : st.cls}`}>{st.text}</span>
      </span>
    </div>
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
  onCounts,
}: {
  currentId: string | null;
  onSelect: (task: CloudTask) => void;
  /** App 在任务创建/终止后 bump,触发整表重拉 */
  reloadKey?: number;
  /** 任务删除成功后回调(带任务 id);App 据此清空当前打开的同 id 视图 */
  onDeleted?: (id: string) => void;
  /** 侧栏搜索词(已 trim/lowercase);非空时过滤行并强制展开折叠段 */
  query?: string;
  /** 计数上报(面板头副标题「N 个项目 · M 个任务」) */
  onCounts?: (counts: { projects: number; tasks: number }) => void;
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

  const taskCount = feed.total ?? feed.tasks?.length ?? 0;
  useEffect(() => {
    if (feed.tasks !== null) onCounts?.({ projects: projects.length, tasks: taskCount });
  }, [feed.tasks, projects.length, taskCount, onCounts]);

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
      <div role="alert" className="mx-1 my-2 flex flex-col items-start gap-1 rounded-[9px] bg-error/10 px-2.5 py-2 text-[11px] text-error">
        <span className="break-all">{t("cloud.list.error", { reason: feed.error })}</span>
        <button type="button" className="font-bold" onClick={feed.refresh}>
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
    return (
      <EmptyState
        icon={<Cloud size={19} strokeWidth={1.5} aria-hidden />}
        title={t("cloud.list.empty.title")}
        detail={t("cloud.list.empty.detail")}
      />
    );
  }

  const activeRows = feed.active.filter(hit);
  const historyRows = feed.history.filter(hit);

  const groupBody = (key: string) => {
    const state = groupTasks[key];
    const rows = (state?.tasks ?? []).filter(hit);
    return (
      <div className="flex flex-col gap-0.5 pb-1.5">
        {state?.loading && (
          <span className="px-3 py-1 text-[10.5px] text-base-content/35">{t("cloud.list.loading")}</span>
        )}
        {state?.error && <span className="px-3 py-1 text-[10.5px] text-warning">{t("cloud.list.groupError", { reason: state.error })}</span>}
        {state?.tasks && rows.length === 0 && (
          <span className="px-3 py-1 text-[10.5px] text-base-content/35">{t("cloud.list.groupEmpty")}</span>
        )}
        {rows.map((task) => (
          <TaskRow key={task.id} task={task} depth={1} currentId={currentId} onSelect={onSelect} onDelete={handleDelete} onStop={handleStop} />
        ))}
      </div>
    );
  };

  const projectGroup = (key: string, name: string, projectId: string | null) => {
    const open = forceOpen || openGroups.has(key);
    return (
      <div key={key} className="flex flex-col gap-px">
        <GroupHeader
          project
          name={name}
          expanded={open}
          onToggle={() => {
            setOpenGroups((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else {
                next.add(key);
                loadGroup(key, projectId);
              }
              return next;
            });
          }}
        />
        {open && groupBody(key)}
      </div>
    );
  };

  return (
    <>
      {activeRows.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <SectionLabel>{t("cloud.list.active")}</SectionLabel>
          {activeRows.map((task) => (
            <TaskRow key={task.id} task={task} currentId={currentId} onSelect={onSelect} onDelete={handleDelete} onStop={handleStop} />
          ))}
        </div>
      )}
      {historyRows.length > 0 && (
        <div className="flex flex-col gap-px">
          <GroupHeader
            muted
            name={t("cloud.list.history", { n: String(feed.history.length) })}
            expanded={forceOpen || historyOpen}
            onToggle={() => {
              setHistoryOpen((v) => {
                writeFold("mc.cloudHistoryOpen", !v);
                return !v;
              });
            }}
          />
          {(forceOpen || historyOpen) && (
            <div className="flex flex-col gap-0.5 pb-1.5">
              {historyRows.map((task) => (
                <TaskRow key={task.id} task={task} depth={1} currentId={currentId} onSelect={onSelect} onDelete={handleDelete} onStop={handleStop} />
              ))}
              {feed.hasMore && (
                <button
                  type="button"
                  className="mx-1 flex min-h-7 items-center justify-center gap-1.5 rounded-[7px] text-[11px] text-base-content/50 hover:bg-base-content/5"
                  disabled={feed.loading}
                  onClick={feed.loadMore}
                >
                  {feed.loading && <span className="loading loading-spinner loading-xs" aria-hidden />}
                  {t("cloud.list.loadMore")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {projects.length > 0 && (
        <div className="mt-2 flex flex-col gap-px border-t border-base-content/10 pt-2">
          <SectionLabel>{t("cloud.list.projects")}</SectionLabel>
          {projects.map((project) =>
            projectGroup(project.id ?? "", project.name || project.full_name || t("cloud.list.untitledProject"), project.id ?? null),
          )}
          {projectGroup(QUICK_KEY, t("cloud.list.quickStart"), null)}
        </div>
      )}
      {query && activeRows.length === 0 && historyRows.length === 0 && projects.length === 0 && (
        <EmptyState
          icon={<Search size={19} strokeWidth={1.75} aria-hidden />}
          title={t("sidebar.noResults.local.title")}
          detail={t("sidebar.noResults.local.detail")}
        />
      )}
      {actionErr && <span className="px-2 py-1 text-[10.5px] text-error">{actionErr}</span>}
      {feed.error && <span className="px-2 py-1 text-[10.5px] text-error">{t("cloud.list.error", { reason: feed.error })}</span>}
    </>
  );
}
