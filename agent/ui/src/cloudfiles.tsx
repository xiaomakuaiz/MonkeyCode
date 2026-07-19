// 云端任务文件抽屉:经控制流(Control WS 内核代理)浏览 VM 工作区。
// 结构对照 App.tsx 的本地文件抽屉(文件/改动两个 tab + 下方预览窗格),
// 数据源换成 repo_file_list / repo_read_file / repo_file_changes / repo_file_diff
// (与 web 控制台 task-file-explorer 同一套 kind 与字段)。
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  connectCloudControl,
  type CloudControl,
  type CloudFileChange,
  type CloudRepoFile,
} from "./client";
import { b64decode } from "./codec";
import { basename } from "./chat";
import { CodeView, DiffPanel, MONO } from "./components";
import { IconChevronRight, IconFile, IconFolder, IconX } from "./icons";

const fileRow: CSSProperties = {
  height: 32,
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "0 10px",
  borderRadius: 8,
  cursor: "pointer",
  minWidth: 0,
  flex: "none",
};

const changeTag: CSSProperties = {
  flex: "none",
  fontSize: 10.5,
  fontWeight: 600,
  borderRadius: 9,
  padding: "2px 8px",
  lineHeight: 1.4,
};

/** 云端改动状态 → 中文标签(词汇对齐 web/移动端:M/A/D/R/RM/??) */
const CHANGE_KIND: Record<string, { text: string; fg: string; bg: string }> = {
  A: { text: "新增", fg: "var(--addT)", bg: "var(--addBg)" },
  "??": { text: "新增", fg: "var(--addT)", bg: "var(--addBg)" },
  M: { text: "修改", fg: "var(--warn)", bg: "var(--warnBg)" },
  D: { text: "删除", fg: "var(--delT)", bg: "var(--delBg)" },
  RM: { text: "删除", fg: "var(--delT)", bg: "var(--delBg)" },
  R: { text: "重命名", fg: "var(--warn)", bg: "var(--warnBg)" },
};

const isDir = (f: CloudRepoFile) => f.entry_mode === 4 || f.entry_mode === 5;

const fmtSize = (n?: number) =>
  n == null ? "" : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B";

const MAX_FILE_SIZE = 1 << 20; // 读取上限 1MB(对齐 web/mobile)

const tabStyle = (active: boolean): CSSProperties => ({
  border: "none",
  background: "transparent",
  height: 34,
  padding: "0 3px",
  marginBottom: -1,
  borderBottom: `2px solid ${active ? "var(--acc)" : "transparent"}`,
  fontSize: 13,
  fontWeight: active ? 700 : 500,
  color: active ? "var(--t1)" : "var(--t5)",
  cursor: active ? "default" : "pointer",
  display: "flex",
  alignItems: "center",
  gap: 6,
  flex: "none",
});

export function CloudFilesDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [tab, setTab] = useState<"files" | "changes">("files");
  const [tree, setTree] = useState<Map<string, CloudRepoFile[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [changes, setChanges] = useState<CloudFileChange[] | null>(null);
  const [viewer, setViewer] = useState<{ path: string; kind: "code" | "diff" | "plain"; text: string } | null>(null);
  const [err, setErr] = useState("");
  const ctrlRef = useRef<CloudControl | null>(null);

  // 建控制流连接 + 拉根目录与改动
  useEffect(() => {
    const ctrl = connectCloudControl(taskId);
    ctrlRef.current = ctrl;
    void loadChildren(ctrl, "");
    ctrl
      .call<{ changes?: CloudFileChange[] }>("repo_file_changes")
      .then((r) => setChanges(r.changes ?? []))
      .catch(() => setChanges([]));
    return () => {
      ctrl.close();
      ctrlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const loadChildren = async (ctrl: CloudControl, dir: string) => {
    setLoadingDirs((s) => new Set(s).add(dir));
    try {
      const r = await ctrl.call<{ files?: CloudRepoFile[] }>("repo_file_list", {
        path: dir,
        glob_pattern: "*",
        include_hidden: true,
      });
      const files = (r.files ?? [])
        .filter((f) => f.name !== ".git")
        .sort((a, b) => (isDir(b) ? 1 : 0) - (isDir(a) ? 1 : 0) || a.name.localeCompare(b.name));
      setTree((m) => new Map(m).set(dir, files));
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDirs((s) => {
        const n = new Set(s);
        n.delete(dir);
        return n;
      });
    }
  };

  const toggleDir = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!tree.has(dir) && ctrlRef.current) void loadChildren(ctrlRef.current, dir);
      }
      return next;
    });
  };

  const showFile = async (f: CloudRepoFile) => {
    if ((f.size ?? 0) > MAX_FILE_SIZE) {
      setViewer({ path: f.path, kind: "plain", text: `文件较大(${fmtSize(f.size)}),请在网页控制台查看` });
      return;
    }
    setViewer({ path: f.path, kind: "plain", text: "加载中…" });
    try {
      const r = await ctrlRef.current!.call<{ content?: string }>("repo_read_file", {
        path: f.path,
        offset: 0,
        length: MAX_FILE_SIZE,
      });
      const text = r.content ? b64decode(r.content) : "";
      if (!text) setViewer({ path: f.path, kind: "plain", text: "(空文件)" });
      else if (text.includes("\0")) setViewer({ path: f.path, kind: "plain", text: "二进制文件,不支持预览" });
      else setViewer({ path: f.path, kind: "code", text });
    } catch (e) {
      setViewer({ path: f.path, kind: "plain", text: "✗ " + (e instanceof Error ? e.message : String(e)) });
    }
  };

  const showDiff = async (path: string) => {
    setViewer({ path, kind: "plain", text: "加载中…" });
    try {
      const r = await ctrlRef.current!.call<{ diff?: string }>("repo_file_diff", {
        path,
        unified: true,
        context_lines: 20,
      });
      setViewer({ path, kind: "diff", text: r.diff || "(无差异)" });
    } catch (e) {
      setViewer({ path, kind: "plain", text: "✗ " + (e instanceof Error ? e.message : String(e)) });
    }
  };

  const changeMap = new Map((changes ?? []).map((c) => [c.path, c.status] as const));

  const renderTree = (dir: string, depth: number): ReactNode[] => {
    const pad = 10 + depth * 16;
    const rows: ReactNode[] = [];
    const items = tree.get(dir);
    if (!items) {
      if (loadingDirs.has(dir)) {
        for (let i = 0; i < (dir === "" ? 4 : 1); i++) {
          rows.push(
            <div key={`ld:${dir}:${i}`} style={{ ...fileRow, cursor: "default", paddingLeft: pad + 21 }}>
              <span className="skeleton" style={{ width: 14, height: 14, borderRadius: 4 }} />
              <span className="skeleton" style={{ height: 10, width: 110 + (i % 3) * 52 }} />
            </div>,
          );
        }
      }
      return rows;
    }
    for (const f of items) {
      const dirEntry = isDir(f);
      const st = dirEntry ? undefined : changeMap.get(f.path);
      const kind = st ? CHANGE_KIND[st] : undefined;
      const open = dirEntry && expanded.has(f.path);
      const active = viewer?.path === f.path;
      rows.push(
        <div
          key={f.path}
          className={active ? undefined : "hv"}
          title={f.path}
          onClick={() => (dirEntry ? toggleDir(f.path) : kind ? void showDiff(f.path) : void showFile(f))}
          style={{ ...fileRow, paddingLeft: pad, background: active ? "var(--hov)" : "transparent" }}
        >
          <span style={{ width: 12, flex: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {dirEntry && (
              <IconChevronRight
                size={8}
                color="var(--t5)"
                style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s ease" }}
              />
            )}
          </span>
          {dirEntry ? <IconFolder size={14} color="var(--acc)" /> : <IconFile color={kind ? kind.fg : "var(--t4)"} />}
          <span className="ellipsis" style={{ flex: 1, fontSize: 12.5, color: "var(--t1)" }}>
            {f.name}
          </span>
          {!dirEntry && kind && <span style={{ ...changeTag, color: kind.fg, background: kind.bg }}>{kind.text}</span>}
          {!dirEntry && !kind && (
            <span style={{ flex: "none", width: 60, textAlign: "right", font: "10.5px " + MONO, color: "var(--t6)" }}>
              {fmtSize(f.size)}
            </span>
          )}
        </div>,
      );
      if (open) rows.push(...renderTree(f.path, depth + 1));
    }
    if (items.length === 0) {
      rows.push(
        <div key={"empty:" + dir} style={{ ...fileRow, cursor: "default", paddingLeft: pad + 21 }}>
          <span style={{ fontSize: 11.5, color: "var(--t6)" }}>(空)</span>
        </div>,
      );
    }
    return rows;
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* 头部 tab(与本地文件抽屉一致) */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, padding: "6px 14px 0 20px", borderBottom: "1px solid var(--line2)", flex: "none", whiteSpace: "nowrap" }}>
        <button className={tab === "files" ? undefined : "hv-t1"} style={tabStyle(tab === "files")} onClick={() => setTab("files")}>
          文件
        </button>
        <button className={tab === "changes" ? undefined : "hv-t1"} style={tabStyle(tab === "changes")} onClick={() => setTab("changes")}>
          改动
          {changes && changes.length > 0 && (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--acc)", background: "var(--accBg)", borderRadius: 8, padding: "0 6px", lineHeight: "15px" }}>
              {changes.length}
            </span>
          )}
        </button>
        <button className="hv2 icon-btn" title="关闭 (esc)" onClick={onClose} style={{ marginLeft: "auto", alignSelf: "center", width: 24, height: 24 }}>
          <IconX size={11} color="var(--t4)" />
        </button>
      </div>

      {err && <div style={{ padding: "6px 20px 0", fontSize: 12, color: "var(--err)", flex: "none" }}>{err}</div>}

      {/* 列表(查看器打开时收拢为上方窗口) */}
      <div
        style={{
          flex: viewer ? "none" : 1,
          maxHeight: viewer ? "38%" : undefined,
          overflowY: "auto",
          padding: "6px 12px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        {tab === "changes" ? (
          <>
            {[...(changes ?? [])]
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((c) => {
                const kind = CHANGE_KIND[c.status] ?? { text: c.status, fg: "var(--t4)", bg: "var(--hov)" };
                const sep = c.path.lastIndexOf("/");
                const dir = sep > 0 ? c.path.slice(0, sep) : "";
                const active = viewer?.path === c.path;
                return (
                  <div
                    key={c.path}
                    className={active ? undefined : "hv"}
                    title={c.path}
                    onClick={() => void showDiff(c.path)}
                    style={{ ...fileRow, background: active ? "var(--hov)" : "transparent" }}
                  >
                    <IconFile color={kind.fg} />
                    <span style={{ flex: "none", fontSize: 12.5, color: c.status === "D" ? "var(--t5)" : "var(--t1)", textDecoration: c.status === "D" ? "line-through" : "none" }}>
                      {basename(c.path)}
                    </span>
                    <span className="ellipsis" style={{ flex: 1, fontSize: 11, fontFamily: MONO, color: "var(--t5)" }}>
                      {dir}
                    </span>
                    {(c.additions ?? 0) > 0 && <span style={{ flex: "none", fontSize: 11, color: "var(--addT)" }}>+{c.additions}</span>}
                    {(c.deletions ?? 0) > 0 && <span style={{ flex: "none", fontSize: 11, color: "var(--delT)" }}>-{c.deletions}</span>}
                    <span style={{ ...changeTag, color: kind.fg, background: kind.bg }}>{kind.text}</span>
                  </div>
                );
              })}
            {(changes ?? []).length === 0 && (
              <div style={{ padding: "36px 0 28px", display: "flex", flexDirection: "column", alignItems: "center", gap: 9 }}>
                <IconFile size={22} color="var(--t6)" />
                <span style={{ fontSize: 12, color: "var(--t5)" }}>{changes ? "还没有文件改动" : "加载中…"}</span>
              </div>
            )}
          </>
        ) : (
          <>{renderTree("", 0)}</>
        )}
      </div>

      {/* 预览窗格 */}
      {viewer && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px 9px 20px", borderTop: "1px solid var(--line2)", background: "var(--bg)", flex: "none", whiteSpace: "nowrap", overflow: "hidden" }}>
            <IconFile color={changeMap.get(viewer.path) ? CHANGE_KIND[changeMap.get(viewer.path)!]?.fg ?? "var(--t4)" : "var(--t4)"} />
            <span style={{ font: "600 12.5px " + MONO, color: "var(--t1)", flex: "none" }}>{basename(viewer.path)}</span>
            <span className="ellipsis" style={{ fontSize: 11, fontFamily: MONO, color: "var(--t5)" }}>{viewer.path}</span>
            <button className="hv2 icon-btn" title="关闭预览" onClick={() => setViewer(null)} style={{ marginLeft: "auto", width: 22, height: 22 }}>
              <IconX size={10} color="var(--t4)" />
            </button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 0 20px" }}>
            {viewer.kind === "diff" ? (
              <DiffPanel text={viewer.text} />
            ) : viewer.kind === "code" ? (
              <CodeView path={viewer.path} text={viewer.text} />
            ) : (
              <pre style={{ margin: 0, padding: "10px 24px", font: "12px/1.9 " + MONO, color: "var(--t4)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {viewer.text}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}
