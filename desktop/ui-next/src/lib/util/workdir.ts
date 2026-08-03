// 工作目录 × 内核运行环境的纯函数(旧工程 host.ts::workdirMatchesEnv 语义
// 重写)。无 IPC、无 DOM;新任务面的"最近目录过滤 / 默认目录推导"共用。

/** 首启默认工作目录(内核解析 ~,createDir 语义下静默创建)。 */
export const DEFAULT_DIR = "~/MonkeyCode";

/** 目录是否属于当前内核运行环境。WSL 模式下 guest 形态(/… 或 \\wsl$ UNC)、
 * Windows 盘符(壳映射为 /mnt/<盘>/…)与 ~ 形态(展开为 guest 家目录)均可
 * 归一化,全放行;本机模式下 guest 形态是 WSL 会话的遗留——Windows 壳上
 * 滤掉(macOS/Linux 本机的 / 开头是正常路径,只滤 UNC)。新任务的"最近
 * 目录/默认目录"按此过滤,切换运行环境后不再预填一个必然失败的路径。 */
export function workdirMatchesEnv(dir: string, kernelEnv: string, windowsShell: boolean): boolean {
  const wsl = kernelEnv.startsWith("wsl:");
  const posix = dir.startsWith("/");
  const unc = /^\\\\wsl(\$|\.localhost)\\/i.test(dir);
  if (wsl) return posix || unc || /^[a-zA-Z]:[\\/]/.test(dir) || dir.startsWith("~");
  return windowsShell ? !posix && !unc : !unc;
}

/** 新建任务的默认目录:WSL 模式用家目录基座(wsl_workdir_base 返回的宿主
 * 视角路径,如 \\wsl$\<发行版>\home\<用户>;Linux 冒烟为 posix 家目录)拼
 * MonkeyCode,分隔符跟随基座形态;本机模式/基座缺失回退 ~/MonkeyCode。 */
export function defaultWorkdir(wslBase: string | null | undefined): string {
  if (!wslBase) return DEFAULT_DIR;
  const sep = wslBase.includes("\\") ? "\\" : "/";
  const trimmed = wslBase.endsWith(sep) ? wslBase.slice(0, -1) : wslBase;
  return `${trimmed}${sep}MonkeyCode`;
}
