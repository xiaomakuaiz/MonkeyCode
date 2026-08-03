// 文件树:目录懒加载(点开才拉子层),子项缓存 + 展开集合 + 目录粒度加载态
// (骨架屏),缩进表达层级(每层 16px,动态 px 走内联样式)。已删除文件只
// 属于「改动」页;这里只展示当前真实存在的文件,改动状态以徽标标注。
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useI18n } from "@/lib/i18n";
import type { RepoEntry } from "@/lib/ipc/repo";
import { fmtSize, statusMeta } from "./status";

export function Tree({
  listDir,
  onOpenFile,
  activePath,
  changeStatus,
}: {
  listDir: (dir: string) => Promise<RepoEntry[]>;
  onOpenFile: (entry: RepoEntry) => void;
  activePath: string | null;
  /** 路径 → 改动状态(文件行徽标;缺省不标注) */
  changeStatus?: ReadonlyMap<string, string>;
}) {
  const { t } = useI18n();
  // 目录 → 子项缓存("" = 工作区根)、展开集合、按目录粒度的加载中标记
  const [tree, setTree] = useState<Map<string, RepoEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");

  // 调用方每次渲染的新闭包经 ref 转接,不搅动 mount effect;
  // 已缓存/在途守卫也用 ref——快速连点时 state 闭包读到的是旧集合
  const listDirRef = useRef(listDir);
  listDirRef.current = listDir;
  const loadedRef = useRef(new Set<string>());
  const pendingRef = useRef(new Set<string>());

  const load = async (dir: string) => {
    if (loadedRef.current.has(dir) || pendingRef.current.has(dir)) return;
    pendingRef.current.add(dir);
    setLoading((s) => new Set(s).add(dir));
    try {
      const items = await listDirRef.current(dir);
      loadedRef.current.add(dir);
      setTree((m) => new Map(m).set(dir, items));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      pendingRef.current.delete(dir);
      setLoading((s) => {
        const n = new Set(s);
        n.delete(dir);
        return n;
      });
    }
  };

  // 挂载即拉根目录(抽屉关闭整体卸载,重开自然是全新状态)
  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 展开/收起目录(展开时懒加载子项,已缓存的即时展开)
  const toggleDir = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void load(dir);
      }
      return next;
    });
  };

  // 展开的目录原地铺开子项,层级用缩进表达
  const renderDir = (dir: string, depth: number): ReactNode[] => {
    const rows: ReactNode[] = [];
    const items = tree.get(dir);
    if (!items) {
      if (loading.has(dir)) {
        for (let i = 0; i < (dir === "" ? 4 : 2); i++) {
          rows.push(
            <div
              key={`skeleton:${dir}:${i}`}
              aria-hidden
              className="flex items-center gap-2 py-1.5 pr-4"
              style={{ paddingLeft: 24 + depth * 16 }}
            >
              <div className="skeleton size-3.5 rounded" />
              <div className="skeleton h-3 w-32" />
            </div>,
          );
        }
      }
      return rows;
    }
    for (const en of items) {
      const open = en.isDir && expanded.has(en.path);
      const meta = !en.isDir && changeStatus ? statusMeta(changeStatus.get(en.path) ?? "") : undefined;
      rows.push(
        <button
          key={en.path}
          type="button"
          title={en.path}
          onClick={() => (en.isDir ? toggleDir(en.path) : onOpenFile(en))}
          className={`flex w-full items-center gap-2 py-1 pr-4 text-left text-xs ${
            activePath === en.path ? "bg-base-200" : "hover:bg-base-200/60"
          }`}
          style={{ paddingLeft: 8 + depth * 16 }}
        >
          <span className="flex w-3 shrink-0 justify-center">{en.isDir && <Chevron open={open} />}</span>
          {en.isDir ? <FolderIcon /> : <FileIcon />}
          <span className="min-w-0 flex-1 truncate">{en.name}</span>
          {meta ? (
            <span className={`badge badge-soft badge-xs shrink-0 ${meta.badgeClass}`}>{t(meta.labelKey)}</span>
          ) : (
            !en.isDir && (
              <span className="shrink-0 font-mono text-[10px] text-base-content/35 tabular-nums">{fmtSize(en.size)}</span>
            )
          )}
        </button>,
      );
      if (open) rows.push(...renderDir(en.path, depth + 1));
    }
    if (items.length === 0) {
      rows.push(
        dir === "" ? (
          <p key="empty-root" className="px-4 py-8 text-center text-xs text-base-content/50">
            {t("files.tree.emptyRoot")}
          </p>
        ) : (
          <p key={`empty:${dir}`} className="py-1 text-xs text-base-content/40" style={{ paddingLeft: 28 + depth * 16 }}>
            {t("files.tree.empty")}
          </p>
        ),
      );
    }
    return rows;
  };

  return (
    <div className="flex flex-col">
      {err && (
        <p role="alert" className="px-4 py-2 text-xs text-error">
          {err}
        </p>
      )}
      {renderDir("", 0)}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className={`text-base-content/40 transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path d="m5 2 6 6-6 6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-base-content/50" aria-hidden>
      <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5v7a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="shrink-0 text-base-content/40"
      aria-hidden
    >
      <path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z" />
      <path d="M9 1.5v4h4" />
    </svg>
  );
}
