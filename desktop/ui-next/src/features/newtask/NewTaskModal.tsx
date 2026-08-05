// 新建任务:主区整页视图(桌面客户端向导页,非网页式弹窗;组件名保留
// NewTaskModal 以稳住既有引用面)。契约(与壳一致):
// - 本地会话:workdir 必填;默认目录(本机 ~/MonkeyCode / WSL 家目录基座下的
//   MonkeyCode)允许静默创建(createDir);其他目录不存在时壳报「…目录不存在…」
//   (desktop/src/driver/session.rs / wsl.rs 的文案契约,壳侧单测钉死),就地
//   换成「创建并继续」确认钮,确认后带 createDir=true 重试
// - 普通对话:workdir 传空串,隐藏 cwd 由壳生成;createDir 恒 false
// - 首条消息(可空):创建成功后经 session_send(user-input, content=b64)发出;
//   发送失败只 console.warn 不阻断——会话已建,onCreated 正常进入,用户可在
//   会话里重发(取舍:失败极罕见,不值得为它加一条跨组件的草稿回传通道)
// - think 档随 session_create 的 think 参数下发(""=跟随模型默认)
// - 最近目录来自 props.recentDirs(App 从 sessions 的 workdir 派生),按内核
//   运行环境过滤(lib/util/workdir);目录预填 = 过滤后首项,无则默认目录
// - 模型记忆 mc.lastTaskModel(本地/对话共用);旧工程无 lastDir 持久化键,
//   不发明新键
import { Check, ChevronDown, Cloud, Folder, FolderGit2, FolderOpen, MessagesSquare, SendHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useI18n } from "@/lib/i18n";
import { getConfig } from "@/lib/ipc/config";
import { isWindowsShell, pickDirectory, wslWorkdirBase } from "@/lib/ipc/host";
import { modelsList, sessionCreate, sessionSend, type ModelInfo, type SessionKind, type SessionMeta } from "@/lib/ipc/sessions";
import { b64encode } from "@/lib/protocol/codec";
import { THINK_LABELS } from "@/lib/protocol/reduce";
import { createImeGuard } from "@/lib/util/slash";
import { readLastTaskModel, rememberLastTaskModel } from "@/lib/util/prefs";
import { DEFAULT_DIR, defaultWorkdir, workdirMatchesEnv } from "@/lib/util/workdir";
import { ModelMenu, ThinkMenu } from "@/features/chat/composer/pickers";
import { NewCloudTask } from "@/features/cloud/NewCloudTask";
import type { CloudTaskDetail } from "@/lib/ipc/cloudtasks";

export { DEFAULT_DIR };

/** 档位全集以 THINK_LABELS(protocol/reduce)为准(""=跟随模型默认领跑)。 */
const THINK_OPTIONS = Object.keys(THINK_LABELS);

export function NewTaskModal({
  open,
  onClose,
  onCreated,
  onCloudCreated,
  recentDirs,
  initialDir,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (meta: SessionMeta) => void;
  onCloudCreated?: (task: CloudTaskDetail) => void;
  /** 最近项目目录(App 从 sessions 的 workdir 去重、按 updated_at 降序派生);
   *  环境过滤与截断在本组件内做 */
  recentDirs?: string[];
  /** 「在此项目新建任务」预填目录:定位 local 页签,且不被异步最近目录覆盖 */
  initialDir?: string;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<SessionKind | "cloud">("local");
  const [dir, setDir] = useState(DEFAULT_DIR);
  const [dirMenu, setDirMenu] = useState(false);
  const [text, setText] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [think, setThink] = useState("");
  const [kernelEnv, setKernelEnv] = useState("");
  const [defaultDir, setDefaultDir] = useState(DEFAULT_DIR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [offerCreate, setOfferCreate] = useState(false);
  // 用户改过目录后,异步到达的预填不再覆盖
  const dirTouched = useRef(false);
  // Enter 直接创建(Shift+Enter 换行);IME 组合中的 Enter 是选字,不触发
  const ime = useRef(createImeGuard());
  // 预填只取"打开那一刻"的最近目录;App 侧列表刷新不重置用户输入
  const recentRef = useRef(recentDirs);
  recentRef.current = recentDirs;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    // 每次打开都是一次全新的创建流:清掉上一次的草稿与错误态
    dirTouched.current = false;
    setDirMenu(false);
    setText("");
    setThink("");
    setError("");
    setOfferCreate(false);
    if (initialDir) {
      setKind("local");
      setDir(initialDir);
      dirTouched.current = true;
    }
    void modelsList().then((list) => {
      if (!alive) return;
      setModels(list);
      const remembered = readLastTaskModel();
      const pick =
        (remembered && list.find((m) => m.name === remembered && !m.locked)) ||
        list.find((m) => m.default && !m.locked) ||
        list.find((m) => !m.locked);
      if (pick) setModel(pick.name);
    });
    // 运行环境 → 默认目录/最近目录过滤:WSL 模式默认目录落在 guest 家目录基座
    void (async () => {
      const env = (await getConfig().catch(() => null))?.kernel_env ?? "";
      const base = env.startsWith("wsl:") ? await wslWorkdirBase() : null;
      if (!alive) return;
      const fallback = defaultWorkdir(base);
      setKernelEnv(env);
      setDefaultDir(fallback);
      if (dirTouched.current) return;
      const recents = (recentRef.current ?? []).filter((p) => workdirMatchesEnv(p, env, isWindowsShell()));
      setDir(recents[0] ?? fallback);
    })();
    return () => {
      alive = false;
    };
  }, [open, initialDir]);

  const pickDir = (p: string) => {
    dirTouched.current = true;
    setDir(p);
    setDirMenu(false);
    setError("");
    setOfferCreate(false);
  };

  const submit = async (forceCreateDir = false) => {
    if (kind === "cloud" || busy) return;
    const chat = kind === "chat";
    const workdir = chat ? "" : dir.trim();
    if (!chat && !workdir) {
      setError(t("create.error.workdirRequired"));
      return;
    }
    setBusy(true);
    setError("");
    setOfferCreate(false);
    try {
      const meta = await sessionCreate({
        workdir,
        model,
        createDir: !chat && (forceCreateDir || workdir === defaultDir),
        kind: chat ? "chat" : "local",
        think,
      });
      if (model) rememberLastTaskModel(model);
      const first = text.trim();
      if (first) {
        // 随建随发;失败不阻断打开会话(会话已建,用户可在会话内重发)
        try {
          await sessionSend(meta.id, "user-input", { content: b64encode(first) });
        } catch (e) {
          console.warn("首条消息发送失败(会话已创建,可在会话内重发):", e);
        }
      }
      onCreated(meta);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // 壳的文案契约:目录缺失的 Err 必含「目录不存在」(本机与 WSL 两条路径同款)
      if (!chat && msg.includes("目录不存在")) setOfferCreate(true);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  const recents = (recentDirs ?? []).filter((p) => workdirMatchesEnv(p, kernelEnv, isWindowsShell())).slice(0, 6);
  const dirName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  const KIND_META = [
    { k: "local" as const, icon: FolderGit2, label: t("create.kind.local") },
    { k: "chat" as const, icon: MessagesSquare, label: t("create.kind.chat") },
    { k: "cloud" as const, icon: Cloud, label: t("create.kind.cloud") },
  ];
  const onTextKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (ime.current.isImeEnter(e.timeStamp, e.nativeEvent.isComposing)) return;
    e.preventDefault();
    void submit();
  };
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto bg-base-100">
      <header data-view-header="" data-tauri-drag-region="" className="flex h-13 shrink-0 items-center gap-2 border-b border-base-300 px-4">
        <h1 data-tauri-drag-region="" className="min-w-0 flex-1 truncate text-sm font-semibold">{t("create.title")}</h1>
        <button
          type="button"
          aria-label={t("create.cancel")}
          className="btn btn-ghost btn-square btn-sm"
          onClick={onClose}
        >
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </header>
      {/* 向导列(对齐旧工程新建任务屏):logo+标语的 hero → 类型页签 → 一张
          大圆角输入卡承载全部配置——目录/描述/模型是"一件事",不拆散成表单 */}
      <div className="mx-auto w-full max-w-xl px-6 pt-[max(1.5rem,calc(11vh-3.25rem))] pb-10">
        <div className="flex flex-col gap-4">
          <div className="mb-1 flex flex-col items-center gap-1.5">
            <img src="/logo.png" alt="" aria-hidden draggable={false} className="h-13 w-13" />
            <h2 className="mt-1 text-lg font-bold">
              {kind === "chat" ? t("create.hero.chatTitle") : t("create.hero.taskTitle")}
            </h2>
            <p className="text-xs text-base-content/60">
              {kind === "chat" ? t("create.hero.chatDetail") : t("create.hero.taskDetail")}
            </p>
          </div>
          <div role="tablist" aria-label={t("create.title")} className="tabs-box tabs tabs-sm mx-auto">
            {KIND_META.map(({ k, icon: Icon, label }) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                className={`tab gap-1.5 px-4 font-semibold transition-colors duration-150 ${kind === k ? "tab-active" : ""}`}
                onClick={() => setKind(k)}
              >
                <Icon size={14} strokeWidth={1.75} aria-hidden />
                {label}
              </button>
            ))}
          </div>
          <div className="relative flex flex-col rounded-2xl border border-base-300 bg-base-100 shadow-lg transition-colors focus-within:border-base-content/25">
            {kind === "cloud" ? (
              <NewCloudTask
                onCreated={(task) => {
                  onCloudCreated?.(task);
                  onClose();
                }}
              />
            ) : (
              <>
                {/* 卡头:本地任务是「在 × 文件夹里工作」句式触发器(富下拉:
                    最近目录/系统选择/手输路径);本地会话是一行说明 */}
                {kind === "local" ? (
                  <div
                    className="relative px-2 pt-2"
                    onBlur={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDirMenu(false);
                    }}
                  >
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm max-w-full justify-start gap-1.5 px-2 font-normal"
                      aria-label={t("create.recentDirs")}
                      aria-expanded={dirMenu}
                      onClick={() => setDirMenu(!dirMenu)}
                    >
                      <Folder size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-base-content/60" />
                      {dir.trim() ? (
                        <>
                          <span className="shrink-0 text-xs text-base-content/50">{t("create.dirPre")}</span>
                          <span className="min-w-0 truncate text-xs font-semibold" title={dir}>{dirName(dir)}</span>
                          <span className="shrink-0 text-xs text-base-content/50">{t("create.dirPost")}</span>
                        </>
                      ) : (
                        <span className="text-xs text-base-content/50">{t("create.workdirPlaceholder")}</span>
                      )}
                      <ChevronDown
                        size={12}
                        strokeWidth={1.75}
                        aria-hidden
                        className={`shrink-0 text-base-content/50 transition-transform duration-150 ${dirMenu ? "rotate-180" : ""}`}
                      />
                    </button>
                    {dirMenu && (
                      <ul
                        aria-label={t("create.recentDirs")}
                        className="absolute start-2 top-full z-20 mt-1 flex w-96 max-w-[calc(100%-1rem)] flex-col rounded-box border border-base-300 bg-base-100 p-1.5 shadow-lg"
                      >
                        {recents.length > 0 && (
                          <li aria-hidden className="px-2 pt-1 pb-0.5 text-[10px] font-bold tracking-wider text-base-content/40">
                            {t("create.recentGroup")}
                          </li>
                        )}
                        {recents.map((p) => (
                          <li key={p}>
                            <button
                              type="button"
                              aria-label={p}
                              aria-current={p === dir ? "true" : undefined}
                              className={`btn btn-ghost btn-sm h-auto w-full justify-start gap-2 px-2 py-1.5 font-normal ${p === dir ? "btn-active" : ""}`}
                              onClick={() => pickDir(p)}
                            >
                              <Folder size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-base-content/50" />
                              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                                <span className="max-w-full truncate text-xs font-medium">{dirName(p)}</span>
                                <span className="max-w-full truncate font-mono text-[10px] text-base-content/50">{p}</span>
                              </span>
                              {p === dir && <Check size={12} strokeWidth={2} aria-hidden className="shrink-0 text-primary" />}
                            </button>
                          </li>
                        ))}
                        <li aria-hidden className="my-1 border-t border-base-300" />
                        <li>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm w-full justify-start gap-2 px-2 font-normal text-base-content/70"
                            onClick={() => {
                              setDirMenu(false);
                              void pickDirectory().then((picked) => {
                                if (picked) pickDir(picked);
                              });
                            }}
                          >
                            <FolderOpen size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-base-content/50" />
                            {t("create.pickOther")}
                          </button>
                        </li>
                        {/* 手输路径:浏览器模式没有原生目录选择;壳内也可直接粘贴 */}
                        <li className="flex items-center gap-1.5 px-2 pt-1.5 pb-1">
                          <input
                            className="input input-xs flex-1 font-mono"
                            aria-label={t("create.workdir")}
                            placeholder={t("create.workdirPlaceholder")}
                            value={dir}
                            onChange={(e) => {
                              dirTouched.current = true;
                              setDir(e.target.value);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                setDirMenu(false);
                              }
                            }}
                          />
                          <button type="button" className="btn btn-xs" onClick={() => setDirMenu(false)}>
                            {t("create.dirConfirm")}
                          </button>
                        </li>
                      </ul>
                    )}
                  </div>
                ) : (
                  /* 与本地页文件夹触发器同高(mt-2 + h-8):切页签卡头不跳动 */
                  <div className="mx-2 mt-2 flex h-8 items-center gap-2 px-2 text-xs text-base-content/50">
                    <MessagesSquare size={13} strokeWidth={1.75} aria-hidden />
                    {t("create.hint.chat")}
                  </div>
                )}
                <textarea
                  aria-label={t("create.firstMessage")}
                  autoFocus
                  className="textarea min-h-24 w-full resize-none border-0 bg-transparent px-4 text-sm leading-relaxed shadow-none focus:outline-none"
                  rows={4}
                  placeholder={t("create.firstMessagePlaceholder")}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onCompositionEnd={(e) => ime.current.markEnd(e.timeStamp)}
                  onKeyDown={onTextKey}
                />
                <div className="flex items-center gap-1 px-2.5 pb-2.5">
                  {/* 模型/思考档与会话 composer 同一组件(features/chat/composer/
                      pickers):左置触发器,菜单向上首端对齐 */}
                  <ModelMenu
                    models={models}
                    current={model}
                    onPick={setModel}
                    ariaLabel={t("create.model")}
                    title={t("create.model")}
                    align="start"
                  />
                  <ThinkMenu
                    current={think}
                    display={think || models.find((m) => m.name === model)?.think || "low"}
                    levels={THINK_OPTIONS}
                    onPick={setThink}
                    ariaLabel={t("create.think")}
                    title={t("create.think")}
                    align="start"
                  />
                  <span className="flex-1" />
                  <button type="button" className="btn btn-primary btn-sm gap-1.5" disabled={busy} onClick={() => void submit()}>
                    {busy && <span className="loading loading-spinner loading-xs" aria-hidden />}
                    {t("create.submit")}
                    {!busy && <SendHorizontal size={12} strokeWidth={2} aria-hidden />}
                  </button>
                </div>
              </>
            )}
          </div>
          {kind !== "cloud" &&
            (offerCreate ? (
              <div role="alert" className="flex items-center gap-2 px-2 text-xs text-error">
                <span>{t("create.dirMissing")}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs text-warning"
                  disabled={busy}
                  onClick={() => void submit(true)}
                >
                  {t("create.dirCreate")}
                </button>
              </div>
            ) : error ? (
              <div role="alert" className="px-2 text-xs leading-relaxed text-error">
                {error}
              </div>
            ) : null)}
        </div>
      </div>
    </main>
  );
}
