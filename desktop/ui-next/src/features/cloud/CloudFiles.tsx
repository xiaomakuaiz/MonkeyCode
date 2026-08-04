// 云端任务文件页:经控制流(Control WS 内核代理)浏览 VM 工作区
// (repo_file_list,与 web 控制台 task-file-explorer 同一套 kind 与字段),
// 上传走 REST mc_file_upload、下载走全局下载 store(startDownload,内含
// dl-progress 先监听后命令的铁律;目录由服务端打成 zip)。
// 控制流懒建 + call() 懒重连:连不上时不无限拨号刷屏,操作时再试。
import { CornerUpLeft, Download, File, Folder, FolderOpen, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { connectCloudControl, WAKE_CALL_TIMEOUT_MS, type CloudControl } from "@/lib/cloud/control";
import { useI18n } from "@/lib/i18n";
import { mcFileUpload, pickSaveFile, readFileBase64 } from "@/lib/ipc/cloudtasks";
import { startDownload } from "@/lib/ipc/downloads";

/** repo_file_list 条目;entry_mode 4=目录 5=子模块(对齐 web task-shared.ts)。 */
export interface CloudRepoFile {
  name: string;
  path: string;
  entry_mode: number;
  size?: number;
  modified_at?: number;
}

const isDir = (f: CloudRepoFile) => f.entry_mode === 4 || f.entry_mode === 5;

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 上传上限 10MB(对齐 web 控制台文件树)

/** 树内相对路径 → VM 内绝对路径(与 web 同一约定:工作区固定挂 /workspace)。 */
const vmPath = (rel: string) => "/workspace" + (rel ? "/" + rel : "");

export function fmtSize(size?: number): string {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function CloudFiles({
  taskId,
  vmId,
  onClose,
  makeControl = (id) => connectCloudControl(id),
}: {
  taskId: string;
  /** 任务 VM id(REST 上传/下载按它寻址);空 = 无上传/下载入口(VM 未就绪/已结束) */
  vmId?: string;
  onClose?: () => void;
  /** 测试注入口:换假控制流 */
  makeControl?: (taskId: string) => CloudControl;
}) {
  const { t } = useI18n();
  const [dir, setDir] = useState(""); // 当前目录(相对工作区;"" = 根)
  const [files, setFiles] = useState<CloudRepoFile[] | null>(null);
  const [err, setErr] = useState("");
  const [uploading, setUploading] = useState(false);
  const ctrlRef = useRef<CloudControl | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const makeControlRef = useRef(makeControl);
  makeControlRef.current = makeControl;

  // 控制流惰性建立;卸载即断开(云端据此开始空闲倒计时)
  const ensureCtrl = () => (ctrlRef.current ??= makeControlRef.current(taskId));
  useEffect(
    () => () => {
      ctrlRef.current?.close();
      ctrlRef.current = null;
    },
    [taskId],
  );

  // 控制流 call 默认 15s 超时,但拨号会触发休眠 VM 唤醒(以分钟计):
  // 全部调用给足唤醒余量,免得唤醒期间必然超时
  const wakeOpts = { timeoutMs: WAKE_CALL_TIMEOUT_MS, timeoutMsg: t("cloud.ctl.wakeTimeout") };

  const list = (target: string) => {
    setFiles(null);
    setErr("");
    ensureCtrl()
      .call<{ files?: CloudRepoFile[] }>(
        "repo_file_list",
        { path: target, glob_pattern: "*", include_hidden: true },
        wakeOpts,
      )
      .then((r) => {
        setFiles(
          (r.files ?? [])
            .filter((f) => f.name !== ".git")
            .sort((a, b) => (isDir(b) ? 1 : 0) - (isDir(a) ? 1 : 0) || a.name.localeCompare(b.name)),
        );
      })
      .catch((e: unknown) => {
        setFiles([]);
        setErr(e instanceof Error ? e.message : String(e));
      });
  };

  useEffect(() => {
    list(dir);
    // list 依赖的 ensureCtrl/t 均稳定;dir/taskId 变化时重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, taskId]);

  const download = async (f: CloudRepoFile) => {
    if (!vmId) return;
    const filename = isDir(f) ? f.name + ".zip" : f.name;
    const dest = await pickSaveFile(filename);
    if (!dest) return; // 用户取消
    // 登记到全局下载条即返回:进度/结果在下载 dock 外显,关页面不中断
    void startDownload({ vmId, path: vmPath(f.path), filename, dest });
  };

  const upload = async (picked: File[]) => {
    if (!vmId || picked.length === 0) return;
    setUploading(true);
    setErr("");
    try {
      // 顺序进行、失败即止:已传成功的部分随刷新可见
      for (const f of picked) {
        if (f.size === 0) throw new Error(t("cloud.files.uploadEmpty", { name: f.name }));
        if (f.size > MAX_UPLOAD_SIZE) throw new Error(t("cloud.files.uploadTooLarge", { name: f.name }));
        const b64 = await readFileBase64(f);
        await mcFileUpload(vmId, vmPath(dir ? dir + "/" + f.name : f.name), b64);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      list(dir);
    }
  };

  const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";

  return (
    <section aria-label={t("cloud.files.title")} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-base-300 px-3">
        <span className="text-sm font-semibold">{t("cloud.files.title")}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-base-content/50">
          /{["workspace", dir].filter(Boolean).join("/")}
        </span>
        <button
          type="button"
          aria-label={t("cloud.files.refresh")}
          title={t("cloud.files.refresh")}
          className="btn btn-ghost btn-square btn-xs"
          onClick={() => list(dir)}
        >
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
        </button>
        {vmId && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              aria-label={t("cloud.files.upload")}
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])];
                e.target.value = ""; // 允许重复选同一文件
                void upload(picked);
              }}
            />
            <button type="button" className="btn btn-ghost btn-xs" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading && <span className="loading loading-spinner loading-xs" aria-hidden />}
              {uploading ? t("cloud.files.uploading") : t("cloud.files.upload")}
            </button>
          </>
        )}
        {onClose && (
          <button type="button" className="btn btn-ghost btn-square btn-xs" aria-label={t("cloud.files.close")} onClick={onClose}>
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </header>

      {err && (
        <div role="alert" className="alert alert-error alert-soft m-2 py-1.5 text-xs">
          <span className="break-all">{err}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
        {files === null ? (
          <div className="flex justify-center py-8">
            <span className="loading loading-spinner loading-sm text-base-content/40" aria-label={t("cloud.files.loading")} />
          </div>
        ) : (
          <ul className="menu menu-sm w-full p-0">
            {dir && (
              <li>
                <button type="button" onClick={() => setDir(parent)}>
                  <CornerUpLeft size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-base-content/50" />
                  {t("cloud.files.up")}
                </button>
              </li>
            )}
            {files.length === 0 && (
              // 空态统一形态:图标 + 标题档,居中
              <li className="pointer-events-none flex flex-col items-center gap-1.5 px-3 py-8 text-center">
                <FolderOpen size={20} strokeWidth={1.75} className="text-base-content/30" aria-hidden />
                <span className="text-sm font-semibold">{t("cloud.files.empty")}</span>
              </li>
            )}
            {/* menu 文档形态:主行是 li 的直接子交互件(目录=button,文件=span);
                下载钮是 li 内绝对定位的 .btn(menu.css 里 li 自带 relative、
                .btn 被排除在菜单行样式之外),hover 只切可见性不插入布局 */}
            {files.map((f) => (
              <li key={f.path} className="group">
                {isDir(f) ? (
                  <button type="button" className={vmId ? "pe-9" : undefined} onClick={() => setDir(f.path)}>
                    <Folder size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-base-content/50" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  </button>
                ) : (
                  <span className={vmId ? "pe-9" : undefined}>
                    <File size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-base-content/40" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span className="font-mono text-[10px] text-base-content/40 tabular-nums">{fmtSize(f.size)}</span>
                  </span>
                )}
                {vmId && (
                  <button
                    type="button"
                    aria-label={t("cloud.files.download")}
                    title={t("cloud.files.download")}
                    className="btn btn-ghost btn-square btn-xs absolute end-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    onClick={() => void download(f)}
                  >
                    <Download size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
