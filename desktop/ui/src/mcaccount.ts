// MonkeyCode 账号探测只读取既有会话和任务,刻意不接收登录函数。
// 因此启动、聚焦和定时刷新都不可能隐式用百智云账号创建 MonkeyCode 会话。
import { mcStatus, mcTasks } from "./cloudapi";
import type { CloudTask, CloudTasksResp, McStatus } from "./types";

export interface McAccountSnapshot {
  status: McStatus;
  tasks: CloudTask[];
  /** 账号仍已关联、但任务列表本次刷新失败。 */
  taskError?: string;
}

export async function inspectMcAccount(
  getStatus: () => Promise<McStatus> = mcStatus,
  getTasks: () => Promise<CloudTasksResp> = () => mcTasks(1, 20),
): Promise<McAccountSnapshot> {
  const status = await getStatus();
  if (!status.logged_in) return { status, tasks: [] };
  try {
    const result = await getTasks();
    return { status, tasks: result.tasks ?? [] };
  } catch (e) {
    return {
      status,
      tasks: [],
      taskError: e instanceof Error ? e.message : String(e),
    };
  }
}
