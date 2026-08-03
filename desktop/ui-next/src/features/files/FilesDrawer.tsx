// 本地会话文件抽屉:右滑面板 + Scrim,文件树/改动两 tab(共用下方预览)。
// daisyUI 的 drawer 组件是 checkbox 驱动的整页布局原语,与受控开合 +
// 拖拽调宽不适配——面板自绘(fixed 定位),组件级仍用 daisyUI
// (tabs/badge/skeleton/loading/btn)。
//
// - 宽度左缘把手可拖,localStorage "mc.drawerWidth"(px,与旧 UI 同键互认);
//   预览打开后列表/预览上下分栏,分栏把手记 "mc.drawerSplit"。拖拽期间锁
//   body 选区与光标。
// - 数据面全部走 lib/ipc/repo(壳内 repo.rs 原生处理);改动列表挂载即拉,
//   refreshToken 自增(调用方在 ChatState.turnEnded 时递增)则重拉。
// - Esc(window capture):抽屉开着只管自己——预览开着先关预览,再一次
//   才关抽屉;层级协调交调用方。
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { useI18n } from "@/lib/i18n";
import { repoChanges, repoFileDiff, repoListDir, repoReadFile, type RepoChange, type RepoEntry } from "@/lib/ipc/repo";
import { Changes } from "./Changes";
import { Preview, type PreviewModel } from "./Preview";
import { Tree } from "./Tree";

const WIDTH_KEY = "mc.drawerWidth";
const SPLIT_KEY = "mc.drawerSplit";
const MIN_WIDTH = 420;
const DEFAULT_WIDTH = 600;
const MAX_STORED_WIDTH = 1200; // 存量值的静态上限;拖拽时上限是窗宽 90%
const MIN_SPLIT = 80;
const PREVIEW_MIN = 160; // 分栏拖拽时预览区至少保留的高度

type Tab = "files" | "changes";

function readWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(WIDTH_KEY) ?? "", 10);
    return Number.isFinite(v) ? Math.min(Math.max(v, MIN_WIDTH), MAX_STORED_WIDTH) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function readSplit(): number {
  try {
    const v = parseInt(localStorage.getItem(SPLIT_KEY) ?? "", 10);
    return Number.isFinite(v) && v > 0 ? Math.max(v, MIN_SPLIT) : 0; // 0 = 未设置,用默认 38%
  } catch {
    return 0;
  }
}

function persist(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    // 只丢持久化
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function FilesDrawer({
  sessionId,
  onClose,
  initialTab = "files",
  refreshToken = 0,
}: {
  sessionId: string;
  onClose: () => void;
  /** 打开时落在哪个 tab(聊天区改动徽标可直达「改动」) */
  initialTab?: Tab;
  /** 改动列表刷新信号:调用方在轮次结束(ChatState.turnEnded)时自增 */
  refreshToken?: number;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [changes, setChanges] = useState<RepoChange[] | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(true); // 未知先按 git 算,探测后收敛
  const [changesErr, setChangesErr] = useState("");
  const [preview, setPreview] = useState<PreviewModel | null>(null);
  const [width, setWidth] = useState(readWidth);
  const [split, setSplit] = useState(readSplit);
  const [draggingW, setDraggingW] = useState(false);
  const [draggingS, setDraggingS] = useState(false);
  const listRef = useRef<HTMLDivElement>(null); // 分栏拖拽的定位基准
  const reqRef = useRef(0); // 切文件/tab/关闭时使旧异步读取结果失效

  // 改动列表:挂载即拉;refreshToken(轮次结束)自增时重拉
  useEffect(() => {
    let alive = true;
    setChangesErr("");
    repoChanges(sessionId).then(
      (r) => {
        if (alive) {
          setChanges(r.changes);
          setIsGitRepo(r.isGitRepo);
        }
      },
      (e: unknown) => {
        if (alive) {
          setChanges([]);
          setChangesErr(errText(e));
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [sessionId, refreshToken]);

  // 非 git 工作区没有「改动」页;异步探测出 false 时从 changes 收敛回 files
  useEffect(() => {
    if (!isGitRepo && tab === "changes") {
      reqRef.current++;
      setPreview(null);
      setTab("files");
    }
  }, [isGitRepo, tab]);

  // Esc(window capture):预览开着先关预览,否则关抽屉。经 ref 读最新值,
  // 监听只挂一次
  const previewOpenRef = useRef(false);
  previewOpenRef.current = preview !== null;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (previewOpenRef.current) {
        reqRef.current++;
        setPreview(null);
      } else {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  const closePreview = () => {
    reqRef.current++;
    setPreview(null);
  };

  const selectTab = (next: Tab) => {
    if (next === tab) return;
    closePreview();
    setTab(next);
  };

  const openFile = (entry: RepoEntry) => {
    const req = ++reqRef.current;
    setPreview({ path: entry.path, mode: "file", state: "loading", text: "" });
    repoReadFile(sessionId, entry.path).then(
      (content) => {
        if (req === reqRef.current) setPreview({ path: entry.path, mode: "file", state: "ready", text: content });
      },
      (e: unknown) => {
        if (req === reqRef.current) setPreview({ path: entry.path, mode: "file", state: "error", text: errText(e) });
      },
    );
  };

  const openDiff = (path: string) => {
    const req = ++reqRef.current;
    setPreview({ path, mode: "diff", state: "loading", text: "" });
    repoFileDiff(sessionId, path).then(
      (diff) => {
        if (req === reqRef.current) setPreview({ path, mode: "diff", state: "ready", text: diff });
      },
      (e: unknown) => {
        if (req === reqRef.current) setPreview({ path, mode: "diff", state: "error", text: errText(e) });
      },
    );
  };

  // 拖拽跟踪:mousedown 后接管 window 的 move/up,期间锁光标与选区。
  // WebKitGTK 与旧 WKWebView 只认带前缀的 user-select 写法,两个都写。
  const trackPointer = (cursor: string, onMove: (ev: MouseEvent) => void, onDone: () => void) => {
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
    document.body.style.setProperty("-webkit-user-select", "none");
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.body.style.removeProperty("-webkit-user-select");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onDone();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 左缘拖拽调宽,松手落盘记忆
  const startWidthDrag = (e: ReactMouseEvent) => {
    e.preventDefault();
    setDraggingW(true);
    trackPointer(
      "col-resize",
      (ev) => {
        const max = Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.9));
        setWidth(Math.min(Math.max(window.innerWidth - ev.clientX, MIN_WIDTH), max));
      },
      () => {
        setDraggingW(false);
        setWidth((w) => {
          persist(WIDTH_KEY, w);
          return w;
        });
      },
    );
  };

  // 列表/预览分栏拖拽:以列表顶为基准算高度,预览区至少保留 PREVIEW_MIN
  const startSplitDrag = (e: ReactMouseEvent) => {
    e.preventDefault();
    const top = listRef.current?.getBoundingClientRect().top ?? 0;
    setDraggingS(true);
    trackPointer(
      "row-resize",
      (ev) => {
        const max = Math.max(window.innerHeight - top - PREVIEW_MIN, MIN_SPLIT);
        setSplit(Math.min(Math.max(ev.clientY - top, MIN_SPLIT), max));
      },
      () => {
        setDraggingS(false);
        setSplit((h) => {
          persist(SPLIT_KEY, h);
          return h;
        });
      },
    );
  };

  const changeStatus = useMemo(() => new Map((changes ?? []).map((c) => [c.path, c.status] as const)), [changes]);
  const listDir = useCallback((dir: string) => repoListDir(sessionId, dir), [sessionId]);

  const listClass = preview
    ? `min-h-0 shrink-0 overflow-y-auto py-1 max-h-[calc(100%-190px)] ${split > 0 ? "" : "h-[38%]"}`
    : "min-h-0 flex-1 overflow-y-auto py-1";

  return (
    <>
      <div aria-hidden className="fixed inset-0 z-30 bg-black/30" onClick={onClose} />
      <section
        aria-label={t("files.label")}
        style={{ width }}
        className="fixed inset-y-0 right-0 z-40 flex max-w-[90vw] flex-col border-l border-base-300 bg-base-100 shadow-xl"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          title={t("files.resizeWidth")}
          onMouseDown={startWidthDrag}
          className={`absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize ${draggingW ? "bg-primary/40" : "hover:bg-primary/20"}`}
        />
        <header className="flex shrink-0 items-center gap-2 border-b border-base-300 pl-2 pr-2">
          <div role="tablist" className="tabs tabs-border">
            <button type="button" role="tab" className={`tab ${tab === "files" ? "tab-active" : ""}`} onClick={() => selectTab("files")}>
              {t("files.tab.files")}
            </button>
            {isGitRepo && (
              <button
                type="button"
                role="tab"
                className={`tab gap-1.5 ${tab === "changes" ? "tab-active" : ""}`}
                onClick={() => selectTab("changes")}
              >
                {t("files.tab.changes")}
                {changes && changes.length > 0 && <span className="badge badge-soft badge-primary badge-xs">{changes.length}</span>}
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label={t("files.close")}
            title={t("files.close")}
            onClick={onClose}
            className="btn btn-ghost btn-square btn-xs ml-auto"
          >
            ✕
          </button>
        </header>
        {changesErr && (
          <p role="alert" className="shrink-0 px-4 py-2 text-xs text-error">
            {changesErr}
          </p>
        )}
        <div ref={listRef} className={listClass} style={preview && split > 0 ? { height: split } : undefined}>
          {tab === "changes" ? (
            <Changes changes={changes} activePath={preview?.path ?? null} onOpen={openDiff} />
          ) : (
            <Tree listDir={listDir} onOpenFile={openFile} activePath={preview?.path ?? null} changeStatus={changeStatus} />
          )}
        </div>
        {preview && (
          <>
            <div
              role="separator"
              aria-orientation="horizontal"
              title={t("files.resizeSplit")}
              onMouseDown={startSplitDrag}
              className={`h-1.5 shrink-0 cursor-row-resize ${draggingS ? "bg-primary/40" : "hover:bg-primary/20"}`}
            />
            <Preview model={preview} status={changeStatus.get(preview.path)} onClose={closePreview} />
          </>
        )}
      </section>
    </>
  );
}
