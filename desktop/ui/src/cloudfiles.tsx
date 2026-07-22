// 云端任务文件抽屉:经控制流(Control WS 内核代理)浏览 VM 工作区。
// 渲染整体复用共享 FilesDrawer(filesdrawer.tsx,与本地文件抽屉同一实现),
// 这里只做数据适配:repo_file_list / repo_read_file / repo_file_changes /
// repo_file_diff(与 web 控制台 task-file-explorer 同一套 kind 与字段),
// 差异是 base64 内容解码、entry_mode 判目录、读取上限与唤醒超时余量。
import { useEffect, useRef, useState } from "react";
import { connectCloudControl, type CloudControl } from "./cloudapi";
import type { CloudFileChange, CloudRepoFile } from "./types";
import { b64decode } from "./codec";
import { FilesDrawer, fmtSize, type FsAdapter } from "./filesdrawer";

const isDir = (f: CloudRepoFile) => f.entry_mode === 4 || f.entry_mode === 5;

const MAX_FILE_SIZE = 1 << 20; // 读取上限 1MB(对齐 web/mobile)

// 控制流 call 默认 15s 超时,但拨号会触发休眠 VM 唤醒(以分钟计):
// 抽屉打开即发的列表/改动调用给足唤醒余量,免得唤醒期间必然超时
const WAKE_CALL_OPTS = { timeoutMs: 90_000, timeoutMsg: "云端环境可能在唤醒中,响应超时,请稍后重试" };

export function CloudFilesDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [changes, setChanges] = useState<CloudFileChange[] | null>(null);
  const [ctrlErr, setCtrlErr] = useState("");
  const ctrlRef = useRef<CloudControl | null>(null);
  // 控制流连接惰性建立:FilesDrawer(子组件)挂载 effect 先于本组件 effect
  // 执行,根目录列取即首个触达点。连不上/反复断开时控制流会放弃自动重连
  // 并外显;之后任何操作(展开目录/看文件)经 call() 懒重连,不再无限拨号刷屏
  const ensureCtrl = () =>
    (ctrlRef.current ??= connectCloudControl(taskId, {
      onStatus: (text, ok) => {
        if (!ok) setCtrlErr(text);
      },
    }));

  // 拉改动(根目录由 FilesDrawer 挂载时经适配层拉取);卸载即断开
  useEffect(() => {
    ensureCtrl()
      .call<{ changes?: CloudFileChange[] }>("repo_file_changes", {}, WAKE_CALL_OPTS)
      .then((r) => setChanges(r.changes ?? []))
      .catch(() => setChanges([]));
    return () => {
      ctrlRef.current?.close();
      ctrlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const adapter: FsAdapter = {
    listDir: async (dir) => {
      const r = await ensureCtrl().call<{ files?: CloudRepoFile[] }>(
        "repo_file_list",
        { path: dir, glob_pattern: "*", include_hidden: true },
        WAKE_CALL_OPTS,
      );
      setCtrlErr(""); // 列表成功即清错(与共享件的 clearErrOnListSuccess 同一历史行为)
      return (r.files ?? [])
        .filter((f) => f.name !== ".git")
        .sort((a, b) => (isDir(b) ? 1 : 0) - (isDir(a) ? 1 : 0) || a.name.localeCompare(b.name))
        .map((f) => ({ name: f.name, path: f.path, isDir: isDir(f), size: f.size }));
    },
    readFile: async (en) => {
      if ((en.size ?? 0) > MAX_FILE_SIZE) return { plain: `文件较大(${fmtSize(en.size)}),请在网页控制台查看` };
      const r = await ensureCtrl().call<{ content?: string }>("repo_read_file", {
        path: en.path,
        offset: 0,
        length: MAX_FILE_SIZE,
      });
      return { content: r.content ? b64decode(r.content) : "" };
    },
    diff: async (path) => {
      const r = await ensureCtrl().call<{ diff?: string }>("repo_file_diff", {
        path,
        unified: true,
        context_lines: 20,
      });
      return r.diff || "(无差异)";
    },
    diffTransientKind: "plain",
    clearErrOnListSuccess: true,
  };

  return (
    <FilesDrawer
      adapter={adapter}
      onClose={onClose}
      changes={changes}
      externalErr={ctrlErr}
      errPad="6px 20px 0"
      listPadTop={6}
      changesEmptyText="还没有文件改动"
      changesLoadingText="加载中…"
      viewerCloseTitle="关闭预览"
    />
  );
}
