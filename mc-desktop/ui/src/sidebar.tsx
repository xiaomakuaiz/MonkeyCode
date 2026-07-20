// 侧栏:云端任务空态 + 本地会话分组列表 + 连接状态/设置入口。
// 布局与数值取自设计稿 Sidebar 区块;macOS 壳内顶部为红绿灯预留拖拽区。
import { useState, type CSSProperties } from "react";
import { isImeEnter, markImeEnd } from "./chat";
import { MacDragSpacer } from "./titlebar";
import {
  IconArchive,
  IconChevronRight,
  IconCloud,
  IconDots,
  IconGear,
  IconMonitor,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "./icons";
import logoUrl from "./logo.png";
import type { CloudTask } from "./client";
import type { SessionMeta } from "./types";

export interface ProjectGroup {
  dir: string;
  name: string;
  latest: string;
  items: SessionMeta[];
}

/** 会话按项目(工作区目录)分组;worktree 会话归属原仓库目录 */
export function groupByProject(sessions: SessionMeta[]): ProjectGroup[] {
  const map = new Map<string, SessionMeta[]>();
  for (const m of sessions) {
    const dir = m.worktree?.repo || m.workdir;
    const list = map.get(dir);
    if (list) list.push(m);
    else map.set(dir, [m]);
  }
  const groups = [...map.entries()].map(([dir, items]) => {
    items.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return {
      dir,
      name: dir.replace(/[\/\\]+$/, "").split(/[\/\\]/).pop() || dir,
      latest: items[0]?.updated_at ?? "",
      items,
    };
  });
  groups.sort((a, b) => b.latest.localeCompare(a.latest));
  return groups;
}

const sectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  fontSize: 11,
  fontWeight: 700,
  color: "var(--t4)",
  padding: "6px 6px 4px",
  letterSpacing: 0.4,
};

/** 云端任务状态文案(与 web/移动端 TaskStatus 词汇一致) */
const CLOUD_STATUS: Record<string, { text: string; color: string }> = {
  pending: { text: "排队中", color: "var(--warn)" },
  processing: { text: "运行中", color: "var(--acc)" },
  error: { text: "出错", color: "var(--err)" },
  finished: { text: "已完成", color: "inherit" },
};

/** 会话行状态文案(时间无信息量,不展示) */
function rowStatus(meta: SessionMeta): { text: string; color: string } {
  // 等待审批优先于"运行中":任务卡住在等人,和真在跑必须可区分
  if (meta.waiting_ask) return { text: "等待审批", color: "var(--warn)" };
  switch (meta.status) {
    case "running":
      return { text: "运行中", color: "var(--acc)" };
    case "error":
      return { text: "出错", color: "var(--err)" };
    case "interrupted":
      return { text: "已中断", color: "inherit" };
    default:
      return { text: meta.turns > 0 ? meta.turns + " 轮" : "", color: "inherit" };
  }
}

function SessionRow({
  meta,
  active,
  attention,
  archived,
  onClick,
  onArchive,
  onDelete,
  onRename,
}: {
  meta: SessionMeta;
  active: boolean;
  /** 后台结束未查看:行尾未读点 */
  attention: boolean;
  archived: boolean;
  onClick: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [hover, setHover] = useState(false); // WKWebView 的 CSS :hover 不可靠,用状态控制
  const [menu, setMenu] = useState<"closed" | "open" | "confirm">("closed");
  // 行内重命名:Enter 确认 / Esc 取消 / 失焦确认;空值或未变则放弃
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commitRename = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== (meta.title || "")) onRename(t);
  };
  // 菜单以 fixed 定位(脱离侧栏滚动容器的裁剪),按 ⋯ 的视口位置计算;
  // 底部空间不足时向上弹,避免被视口遮住
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0 });
  const running = meta.status === "running";
  const showActions = hover || menu !== "closed";
  const st = rowStatus(meta);
  const bg = active ? (archived ? "var(--hov3)" : "var(--accSel)") : "transparent";
  const fg = active && !archived ? "var(--onAcc)" : "var(--t2)";
  const closeMenu = () => setMenu("closed");

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className={active ? undefined : "hv"}
        title={meta.workdir}
        onClick={onClick}
        style={{
          height: 28,
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "0 5px 0 23px",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 12.5,
          background: bg,
          color: fg,
          fontWeight: active ? 500 : 400,
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onCompositionEnd={markImeEnd}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation(); // 不触发全局快捷键(⏎ 审批/esc 关浮层)
              if (e.key === "Enter" && !isImeEnter(e)) commitRename();
              else if (e.key === "Escape") setEditing(false);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              border: "1px solid var(--accBd)",
              borderRadius: 5,
              padding: "2px 6px",
              fontSize: 12.5,
              background: "var(--card)",
              color: "var(--t1)",
              outline: "none",
            }}
          />
        ) : (
          <span className="ellipsis" style={{ flex: 1 }}>{meta.title || "新任务"}</span>
        )}
        {meta.worktree && !showActions && (
          <span
            title="隔离 worktree 会话"
            style={{
              flex: "none",
              fontSize: 10,
              fontWeight: 600,
              color: active ? "var(--onAccDim)" : "var(--acc)",
              background: active ? "var(--onAccBg)" : "var(--accBg)",
              borderRadius: 5,
              padding: "1px 6px",
              marginRight: 3,
            }}
          >
            隔离
          </span>
        )}
        {!showActions ? (
          <span style={{ display: "flex", alignItems: "center", gap: 5, flex: "none", paddingRight: 3 }}>
            {attention && (
              <span
                title="任务已在后台结束"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: meta.status === "error" ? "var(--err)" : "var(--acc)",
                  flex: "none",
                }}
              />
            )}
            <span style={{ fontSize: 11, opacity: 0.7, fontWeight: 400, color: st.color === "inherit" ? undefined : st.color }}>
              {st.text}
            </span>
          </span>
        ) : (
          <button
            title="更多操作"
            onClick={(e) => {
              e.stopPropagation();
              if (menu !== "closed") return closeMenu();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const up = r.bottom + 160 > window.innerHeight; // 预估菜单高度(确认态更高)
              setPos({
                left: Math.min(r.left, window.innerWidth - 170),
                ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
              });
              setMenu("open");
            }}
            className="hv3 icon-btn"
            style={{ width: 20, height: 20, borderRadius: 5, background: menu !== "closed" ? "var(--hov3)" : "transparent" }}
          >
            <IconDots color={active && !archived ? "var(--onAccDim)" : "var(--t3)"} />
          </button>
        )}
      </div>
      {menu !== "closed" && (
        <>
          <div
            className="backdrop"
            onClick={(e) => {
              e.stopPropagation();
              closeMenu();
            }}
          />
          <div
            className="pop"
            style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: 118 }}
            onClick={(e) => e.stopPropagation()}
          >
            {menu === "open" ? (
              <>
                <button
                  className="hv menu-item"
                  onClick={() => {
                    closeMenu();
                    setDraft(meta.title || "");
                    setEditing(true);
                  }}
                >
                  <IconPencil />
                  重命名
                </button>
                <button
                  className="hv menu-item"
                  onClick={() => {
                    closeMenu();
                    onArchive();
                  }}
                >
                  <IconArchive />
                  {meta.archived ? "取消归档" : "归档"}
                </button>
                {running ? (
                  <button className="menu-item" style={{ cursor: "default", color: "var(--t5)" }} title="运行中,请先停止">
                    <IconTrash color="var(--t5)" />
                    删除
                  </button>
                ) : (
                  <button className="hv-errbg menu-item" style={{ color: "var(--err)" }} onClick={() => setMenu("confirm")}>
                    <IconTrash />
                    删除
                  </button>
                )}
              </>
            ) : (
              <>
                <div style={{ padding: "6px 9px 4px", fontSize: 11.5, color: "var(--t4)", lineHeight: 1.6, maxWidth: 200, whiteSpace: "normal" }}>
                  删除后不可恢复。
                  {meta.worktree ? "隔离工作区及未应用改动将一并删除。" : ""}
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    className="hv-errbg menu-item"
                    style={{ color: "var(--err)", fontWeight: 600 }}
                    onClick={() => {
                      closeMenu();
                      onDelete();
                    }}
                  >
                    确认删除
                  </button>
                  <button className="hv menu-item" onClick={closeMenu}>
                    取消
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Group({
  name,
  nameColor,
  expanded,
  onToggle,
  onNewTask,
  children,
}: {
  name: string;
  nameColor?: string;
  expanded: boolean;
  onToggle: () => void;
  onNewTask?: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        className="hv"
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          height: 28,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 4px 0 8px",
          borderRadius: 6,
          cursor: "pointer",
          userSelect: "none",
          fontWeight: 600,
          fontSize: 12.5,
        }}
      >
        <span style={{ width: 12, height: 12, flex: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <IconChevronRight style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s ease" }} />
        </span>
        <span className="ellipsis" style={{ flex: 1, color: nameColor ?? "var(--t1)" }}>
          {name}
        </span>
        {onNewTask && hover && (
          <button
            className="hv3 icon-btn"
            title="在此文件夹新建任务"
            onClick={(e) => {
              e.stopPropagation();
              onNewTask();
            }}
            style={{ width: 20, height: 20, borderRadius: 5 }}
          >
            <IconPlus size={10} color="var(--t3)" />
          </button>
        )}
      </div>
      {expanded && <div style={{ display: "flex", flexDirection: "column", gap: 1, paddingBottom: 3 }}>{children}</div>}
    </div>
  );
}

export function Sidebar({
  sessions,
  currentId,
  attention,
  sessionActive,
  connected,
  status,
  updateAvailable,
  cloudTasks,
  activeCloudId,
  cloudSyncing,
  onRefreshCloud,
  onOpenCloudTask,
  onSelect,
  onNewTask,
  onOpenSettings,
  onArchive,
  onDelete,
  onRename,
}: {
  sessions: SessionMeta[];
  currentId: string | null;
  /** 后台结束未查看的会话(行尾未读点,打开后消除) */
  attention: Set<string>;
  /** 当前处于会话视图(选中态只在会话视图下渲染) */
  sessionActive: boolean;
  connected: boolean;
  status: string;
  updateAvailable: boolean;
  /** 云端任务:null = 未同步云端账号(空态给登录引导),[] = 已同步无任务 */
  cloudTasks: CloudTask[] | null;
  /** 当前在主区打开的云端任务(行高亮) */
  activeCloudId?: string | null;
  /** 云端列表同步中(刷新按钮转圈) */
  cloudSyncing?: boolean;
  /** 手动刷新云端任务列表 */
  onRefreshCloud?: () => void;
  /** 点击云端任务:在桌面内打开详情视图 */
  onOpenCloudTask: (t: CloudTask) => void;
  onSelect: (m: SessionMeta) => void;
  onNewTask: (dir?: string) => void;
  onOpenSettings: () => void;
  onArchive: (m: SessionMeta) => void;
  onDelete: (m: SessionMeta) => void;
  onRename: (m: SessionMeta, title: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("mc.collapsedGroups") || "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const [archivedOpen, setArchivedOpen] = useState(() => localStorage.getItem("mc.archivedOpen") === "1");
  const [cloudHistoryOpen, setCloudHistoryOpen] = useState(() => localStorage.getItem("mc.cloudHistoryOpen") === "1");
  const toggleCloudHistory = () => {
    setCloudHistoryOpen((o) => {
      localStorage.setItem("mc.cloudHistoryOpen", o ? "0" : "1");
      return !o;
    });
  };

  const toggleGroup = (dir: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      localStorage.setItem("mc.collapsedGroups", JSON.stringify([...next]));
      return next;
    });
  };
  const toggleArchived = () => {
    setArchivedOpen((o) => {
      localStorage.setItem("mc.archivedOpen", o ? "0" : "1");
      return !o;
    });
  };

  const list = sessions.filter((m) => !m.archived);
  const archived = sessions
    .filter((m) => m.archived)
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));

  const row = (m: SessionMeta, inArchived: boolean) => (
    <SessionRow
      key={m.id}
      meta={m}
      active={m.id === currentId && sessionActive}
      attention={attention.has(m.id)}
      archived={inArchived}
      onClick={() => onSelect(m)}
      onArchive={() => onArchive(m)}
      onDelete={() => onDelete(m)}
      onRename={(title) => onRename(m, title)}
    />
  );

  return (
    <div
      style={{
        width: 256,
        flex: "none",
        background: "var(--side)",
        borderRight: "1px solid var(--line)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {/* macOS 壳:标题栏 Overlay,红绿灯落在此区,整条可拖拽窗口 */}
      <MacDragSpacer />
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 16px 14px" }}>
        <img src={logoUrl} alt="" draggable={false} style={{ width: 30, height: 30, borderRadius: 8, flex: "none" }} />
        <span style={{ fontWeight: 700, fontSize: 14 }}>MonkeyCode</span>
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: 0.5,
            color: "var(--acc)",
            background: "var(--accBg)",
            borderRadius: 5,
            padding: "1.5px 6px",
            flex: "none",
          }}
        >
          Work
        </span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
        {/* 云端任务:百智云登录后内核桥接 monkeycode 账号自动同步。
            默认只列未结束(排队中/运行中),已结束折叠进"历史任务"按需展开 */}
        <div style={{ ...sectionHeader, marginTop: -1 }}>
          <IconCloud style={{ marginTop: -1 }} />
          <span style={{ flex: 1 }}>云端任务</span>
          {onRefreshCloud && (
            <button
              className="hv2 icon-btn"
              title="刷新云端任务列表"
              onClick={onRefreshCloud}
              style={{ width: 20, height: 20, borderRadius: 5 }}
            >
              <IconRefresh
                color="var(--t4)"
                style={cloudSyncing ? { animation: "mcspin 0.9s linear infinite" } : undefined}
              />
            </button>
          )}
        </div>
        {(() => {
          const taskRow = (t: CloudTask) => {
            const st = CLOUD_STATUS[t.status ?? ""] ?? { text: "", color: "inherit" };
            const label = t.title || t.summary || t.content;
            const active = t.id === activeCloudId;
            return (
              <div
                key={t.id}
                className={active ? undefined : "hv"}
                title={label}
                onClick={() => onOpenCloudTask(t)}
                style={{
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 8px 0 23px",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 12.5,
                  background: active ? "var(--accSel)" : "transparent",
                  color: active ? "var(--onAcc)" : "var(--t2)",
                  fontWeight: active ? 500 : 400,
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                <span className="ellipsis" style={{ flex: 1 }}>{label || "云端任务"}</span>
                <span
                  style={{
                    flex: "none",
                    fontSize: 11,
                    opacity: 0.7,
                    color: active ? "var(--onAccDim)" : st.color === "inherit" ? undefined : st.color,
                  }}
                >
                  {st.text}
                </span>
              </div>
            );
          };
          if (!cloudTasks || cloudTasks.length === 0) {
            return (
              <div
                style={{
                  borderRadius: 8,
                  border: "1px dashed var(--dashBd)",
                  padding: "9px 11px",
                  fontSize: 11.5,
                  color: "var(--t4)",
                  lineHeight: 1.55,
                  marginBottom: 8,
                }}
              >
                {cloudTasks
                  ? "还没有云端任务。在网页或手机端派发的任务会同步到这里。"
                  : "登录百智云账号后,云端任务会自动同步到这里。"}
              </div>
            );
          }
          const running = cloudTasks.filter((t) => t.status === "pending" || t.status === "processing");
          const past = cloudTasks.filter((t) => t.status !== "pending" && t.status !== "processing");
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 1, marginBottom: 8 }}>
              {running.map(taskRow)}
              {running.length === 0 && (
                <div style={{ padding: "3px 8px 4px 23px", fontSize: 11.5, color: "var(--t5)" }}>
                  没有进行中的云端任务
                </div>
              )}
              {past.length > 0 && (
                <>
                  <div
                    className="hv"
                    onClick={toggleCloudHistory}
                    style={{
                      height: 26,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "0 8px 0 5px",
                      borderRadius: 6,
                      cursor: "pointer",
                      userSelect: "none",
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: "var(--t5)",
                    }}
                  >
                    <span style={{ width: 12, height: 12, flex: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <IconChevronRight
                        size={8}
                        style={{ transform: cloudHistoryOpen ? "rotate(90deg)" : "none", transition: "transform .15s ease" }}
                      />
                    </span>
                    历史任务 ({past.length})
                  </div>
                  {cloudHistoryOpen && past.map(taskRow)}
                </>
              )}
            </div>
          );
        })()}

        <div style={sectionHeader}>
          <IconMonitor style={{ marginTop: -1 }} />
          <span style={{ flex: 1 }}>本地会话</span>
          <button className="hv2 icon-btn" title="新建任务" onClick={() => onNewTask()} style={{ width: 20, height: 20, borderRadius: 5 }}>
            <IconPlus color="var(--t4)" />
          </button>
        </div>

        {sessions.length === 0 && (
          <div
            style={{
              borderRadius: 8,
              border: "1px dashed var(--dashBd)",
              padding: "9px 11px",
              fontSize: 11.5,
              color: "var(--t4)",
              lineHeight: 1.55,
            }}
          >
            还没有会话。点上方 + 开始第一个任务。
          </div>
        )}

        {groupByProject(list).map((g) => (
          <Group
            key={g.dir}
            name={g.name}
            expanded={!collapsed.has(g.dir)}
            onToggle={() => toggleGroup(g.dir)}
            onNewTask={() => onNewTask(g.dir)}
          >
            {g.items.map((m) => row(m, false))}
          </Group>
        ))}

        {archived.length > 0 && (
          <Group name="已归档" nameColor="var(--t5)" expanded={archivedOpen} onToggle={toggleArchived}>
            {archived.map((m) => row(m, true))}
          </Group>
        )}
      </div>

      <div style={{ height: 44, flex: "none", display: "flex", alignItems: "center", gap: 7, padding: "0 14px", borderTop: "1px solid var(--line)" }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: connected ? "var(--ok)" : "var(--t6)",
            flex: "none",
          }}
        />
        <span title={status} className="ellipsis" style={{ fontSize: 12, color: "var(--t3)", flex: 1 }}>
          {status}
        </span>
        <button
          className="hv2 icon-btn"
          title="设置"
          onClick={onOpenSettings}
          style={{ position: "relative", width: 26, height: 26, borderRadius: 7, background: "transparent" }}
        >
          {updateAvailable && (
            <span
              style={{
                position: "absolute",
                top: 2,
                right: 2,
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--notice)",
                border: "1.5px solid var(--side)",
              }}
            />
          )}
          <IconGear />
        </button>
      </div>
    </div>
  );
}
