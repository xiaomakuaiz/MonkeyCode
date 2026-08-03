// 侧栏云端空间的任务列表:运行中(pending/processing)置顶,历史
// (finished/error)收进「云端历史」折叠段并按页续拉。导出组件与数据 hook,
// Sidebar 接线由 App 侧完成(本文件不触 features/sidebar)。
// daisyUI 原生形态:menu + details 折叠 + status 状态点 + badge 计数。
import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";
import { inDesktopShell } from "@/lib/ipc/ipc";
import { mcTasks, type CloudTask } from "@/lib/ipc/cloudtasks";

const PAGE_SIZE = 20;

const ACTIVE = new Set(["pending", "processing"]);

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

export function cloudTaskLabel(task: CloudTask, fallback: string): string {
  return task.title || task.summary || task.content || fallback;
}

function StatusDot({ status }: { status?: string }) {
  if (status === "processing") return <span aria-hidden className="status status-primary animate-pulse" />;
  if (status === "pending") return <span aria-hidden className="status status-warning animate-pulse" />;
  if (status === "error") return <span aria-hidden className="status status-error" />;
  return <span aria-hidden className="status opacity-30" />;
}

function TaskRow({
  task,
  currentId,
  onSelect,
}: {
  task: CloudTask;
  currentId: string | null;
  onSelect: (task: CloudTask) => void;
}) {
  const { t } = useI18n();
  return (
    <li>
      <a
        className={`flex items-center gap-2 ${task.id === currentId ? "menu-active" : ""}`}
        onClick={() => onSelect(task)}
      >
        <StatusDot status={task.status} />
        <span className="min-w-0 flex-1 truncate">{cloudTaskLabel(task, t("cloud.list.untitled"))}</span>
      </a>
    </li>
  );
}

export function CloudTaskList({
  currentId,
  onSelect,
  reloadKey = 0,
}: {
  currentId: string | null;
  onSelect: (task: CloudTask) => void;
  /** App 在任务创建/终止后 bump,触发整表重拉 */
  reloadKey?: number;
}) {
  const { t } = useI18n();
  const feed = useCloudTasks(reloadKey);

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

  if (feed.tasks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 px-3 py-8 text-center">
        <div className="text-sm font-semibold text-base-content/55">{t("cloud.list.empty.title")}</div>
        <div className="text-xs text-base-content/40">{t("cloud.list.empty.detail")}</div>
      </div>
    );
  }

  return (
    <ul className="menu menu-sm w-full p-0">
      {feed.active.map((task) => (
        <TaskRow key={task.id} task={task} currentId={currentId} onSelect={onSelect} />
      ))}
      {feed.history.length > 0 && (
        <li>
          <details open={feed.active.length === 0}>
            <summary className="text-base-content/50">
              {t("cloud.list.history")}
              <span className="badge badge-ghost badge-xs">{feed.history.length}</span>
            </summary>
            <ul>
              {feed.history.map((task) => (
                <TaskRow key={task.id} task={task} currentId={currentId} onSelect={onSelect} />
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
      {feed.error && (
        <li className="px-2 py-1 text-[11px] text-error">{t("cloud.list.error", { reason: feed.error })}</li>
      )}
    </ul>
  );
}
