import type { MessageKey } from "./zh";

// 英文词典:键全集由类型钉死(缺一个 key 就 typecheck 失败)。
export const en: Record<MessageKey, string> = {
  "app.name": "MonkeyCode",

  "titlebar.minimize": "Minimize",
  "titlebar.maximize": "Maximize",
  "titlebar.restore": "Restore",
  "titlebar.close": "Close",
  "titlebar.zoom": "Zoom",

  "rail.label": "Spaces",
  "rail.local": "Local sessions",
  "rail.cloud": "Cloud tasks",
  "rail.chat": "Chat",
  "rail.settings": "Settings",

  "sidebar.label": "Sessions",
  "sidebar.search": "Search sessions",
  "sidebar.clearSearch": "Clear search",
  "sidebar.newTask": "New task",
  "sidebar.archived": "Archived",
  "sidebar.archivedProjects": "Archived projects",
  "sidebar.empty.title": "No sessions yet",
  "sidebar.empty.detail": "Click “New task” to start your first task.",
  "sidebar.noResults.title": "No matching sessions",
  "sidebar.noResults.detail": "Try a different keyword.",
  "sidebar.cloud.placeholder": "Cloud task list arrives in a later phase.",
  "sidebar.row.menu": "Session actions",
  "sidebar.row.archive": "Archive",
  "sidebar.row.unarchive": "Unarchive",
  "sidebar.row.delete": "Delete",
  "sidebar.row.deleteConfirm": "Confirm delete",
  "sidebar.project.menu": "Project actions",
  "sidebar.project.archive": "Archive project",
  "sidebar.project.unarchive": "Unarchive project",

  "status.running": "Running",
  "status.waitingAsk": "Awaiting approval",
  "status.error": "Error",
  "status.idle": "Resumable",

  "create.title": "New task",
  "create.workdir": "Project directory",
  "create.workdirPlaceholder": "Pick or type a project directory",
  "create.browse": "Browse…",
  "create.model": "Model",
  "create.kind.local": "Local session",
  "create.kind.chat": "Plain chat",
  "create.submit": "Create",
  "create.cancel": "Cancel",
  "create.error.workdirRequired": "Pick a project directory first",

  "main.welcome.title": "Start a task",
  "main.welcome.detail": "Pick a session on the left, or create a new task.",
  "main.session.placeholder": "Chat view for “{title}” arrives in the next phase.",
  "main.shellInfo": "Shell {version} · Engine {engine}",
  "main.engineNotReady": "not ready",

  "settings.appearance.theme": "Theme",
  "settings.appearance.language": "Language",
  "settings.appearance.hint": "Applies immediately and is remembered on this machine.",

  "md.copy": "Copy",
  "md.copied": "Copied",

  "common.confirm": "Confirm",
  "common.cancel": "Cancel",
};
