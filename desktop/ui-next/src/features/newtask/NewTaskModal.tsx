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
import { ChevronDown, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { getConfig } from "@/lib/ipc/config";
import { isWindowsShell, pickDirectory, wslWorkdirBase } from "@/lib/ipc/host";
import { modelsList, sessionCreate, sessionSend, type ModelInfo, type SessionKind, type SessionMeta } from "@/lib/ipc/sessions";
import { b64encode } from "@/lib/protocol/codec";
import { THINK_LABELS } from "@/lib/protocol/reduce";
import { readLastTaskModel, rememberLastTaskModel } from "@/lib/util/prefs";
import { DEFAULT_DIR, defaultWorkdir, workdirMatchesEnv } from "@/lib/util/workdir";
import { NewCloudTask } from "@/features/cloud/NewCloudTask";
import type { CloudTaskDetail } from "@/lib/ipc/cloudtasks";

export { DEFAULT_DIR };

/** 档位全集以 THINK_LABELS(protocol/reduce)为准,展示走 i18n。 */
const THINK_OPTIONS = Object.keys(THINK_LABELS);
const THINK_KEY: Record<string, MessageKey> = {
  "": "create.think.default",
  off: "chat.think.off",
  low: "chat.think.low",
  medium: "chat.think.medium",
  high: "chat.think.high",
};

export function NewTaskModal({
  open,
  onClose,
  onCreated,
  onCloudCreated,
  recentDirs,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (meta: SessionMeta) => void;
  onCloudCreated?: (task: CloudTaskDetail) => void;
  /** 最近项目目录(App 从 sessions 的 workdir 去重、按 updated_at 降序派生);
   *  环境过滤与截断在本组件内做 */
  recentDirs?: string[];
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
  }, [open]);

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
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-base-100">
      <header data-view-header="" className="flex h-11 shrink-0 items-center gap-2 border-b border-base-300 px-4">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("create.title")}</h1>
        <button
          type="button"
          aria-label={t("create.cancel")}
          className="btn btn-ghost btn-square btn-sm"
          onClick={onClose}
        >
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </header>
      <div className="mx-auto w-full max-w-xl p-6">
        <div className="flex flex-col gap-4">
          <div role="tablist" aria-label={t("create.title")} className="tabs-box tabs tabs-sm w-fit">
            {(["local", "chat", "cloud"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                className={`tab font-semibold transition-colors duration-150 ${kind === k ? "tab-active text-primary" : ""}`}
                onClick={() => setKind(k)}
              >
                {k === "local" ? t("create.kind.local") : k === "chat" ? t("create.kind.chat") : t("create.kind.cloud")}
              </button>
            ))}
          </div>
          {kind === "cloud" && (
            <NewCloudTask
              onCreated={(task) => {
                onCloudCreated?.(task);
                onClose();
              }}
              onCancel={onClose}
            />
          )}
          {kind !== "cloud" && (
            <textarea
              aria-label={t("create.firstMessage")}
              className="textarea textarea-sm w-full resize-none text-sm"
              rows={3}
              placeholder={t("create.firstMessagePlaceholder")}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          {kind === "local" && (
            <fieldset className="fieldset">
              <legend className="fieldset-legend">{t("create.workdir")}</legend>
              <div className="relative">
                <div className="join w-full">
                  <input
                    className="input input-sm join-item w-full font-mono text-xs"
                    aria-label={t("create.workdir")}
                    placeholder={t("create.workdirPlaceholder")}
                    value={dir}
                    onChange={(e) => {
                      dirTouched.current = true;
                      setDir(e.target.value);
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm join-item"
                    aria-label={t("create.recentDirs")}
                    aria-expanded={dirMenu}
                    onClick={() => setDirMenu(!dirMenu)}
                  >
                    <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                </div>
                {dirMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setDirMenu(false)} />
                    <ul
                      aria-label={t("create.recentDirs")}
                      className="menu absolute z-20 mt-1 max-h-56 w-full flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
                    >
                      {recents.map((p) => (
                        <li key={p}>
                          <button
                            type="button"
                            aria-current={p === dir ? "true" : undefined}
                            className={p === dir ? "menu-active" : ""}
                            onClick={() => pickDir(p)}
                          >
                            <span className="truncate font-mono text-xs" title={p}>
                              {p}
                            </span>
                          </button>
                        </li>
                      ))}
                      <li>
                        <button
                          type="button"
                          onClick={() => {
                            setDirMenu(false);
                            void pickDirectory().then((picked) => {
                              if (picked) pickDir(picked);
                            });
                          }}
                        >
                          {t("create.pickOther")}
                        </button>
                      </li>
                    </ul>
                  </>
                )}
              </div>
            </fieldset>
          )}
          {kind !== "cloud" && (
          <div className="grid grid-cols-2 gap-3">
            <fieldset className="fieldset">
              <legend className="fieldset-legend">{t("create.model")}</legend>
              <select
                className="select select-sm w-full"
                aria-label={t("create.model")}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.name} value={m.name} disabled={m.locked}>
                    {m.name}
                  </option>
                ))}
              </select>
            </fieldset>
            <fieldset className="fieldset">
              <legend className="fieldset-legend">{t("create.think")}</legend>
              <select
                className="select select-sm w-full"
                aria-label={t("create.think")}
                value={think}
                onChange={(e) => setThink(e.target.value)}
              >
                {THINK_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {t(THINK_KEY[v] ?? "create.think.default")}
                  </option>
                ))}
              </select>
            </fieldset>
          </div>
          )}
          {kind !== "cloud" && offerCreate ? (
            <div role="alert" className="alert alert-warning alert-soft py-1.5 text-xs">
              <span>{t("create.dirMissing")}</span>
              <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void submit(true)}>
                {t("create.dirCreate")}
              </button>
            </div>
          ) : kind !== "cloud" && error ? (
            <div role="alert" className="alert alert-error alert-soft py-1.5 text-xs">
              {error}
            </div>
          ) : null}
          {kind !== "cloud" && (
            <div className="mt-1 flex items-center justify-end gap-2">
              <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
                {t("create.cancel")}
              </button>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
                {busy && <span className="loading loading-spinner loading-xs" aria-hidden />}
                {t("create.submit")}
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
