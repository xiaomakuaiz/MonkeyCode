// 新建云端任务面板:卡头「关联仓库」选择器 + mc_task_options 三选器
// (模型/宿主机/镜像)+ 任务描述,提交 mc_task_create(壳补默认档位:
// 公共宿主机/opencode/2核8G3小时/官方技能)。
// 导出纯面板组件(不带 dialog 壳),newtask 弹窗接线由 App 侧完成。
// 默认值规则与 Web/mobile 同源(lib/cloud/options 纯函数):
// - 模型:会员档匹配的内置档 → 公共 → 任意;locked(超会员档)禁选;
// - 宿主机:服务端 task_defaults 有效则用,否则公共宿主;公共模型强制公共宿主;
// - 镜像:公共 devbox → is_default → 第一个;
// - 仓库:默认不关联(快速开始);选云端项目下发 project_id,手输地址下发
//   repo_url,两者互斥(选一个即清掉另一个)。
import { Check, Cloud, ChevronDown, Folder, SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { OptionMenu } from "@/features/chat/composer/pickers";

import {
  cloudHostLabel,
  cloudImageLabel,
  cloudRepoLabel,
  groupCloudModels,
  groupedCloudModelLabel,
  isPublicModel,
  pickDefaultCloudHost,
  pickDefaultCloudImage,
  pickDefaultCloudModel,
  usableCloudHosts,
  validCloudRepoUrl,
} from "@/lib/cloud/options";
import { useI18n } from "@/lib/i18n";
import { mcTaskCreate, mcTaskOptions, type CloudProject, type CloudTaskDetail, type McTaskOptions } from "@/lib/ipc/cloudtasks";
import { createImeGuard } from "@/lib/util/slash";

export function NewCloudTask({
  onCreated,
  onCancel,
  initialProject,
}: {
  onCreated: (task: CloudTaskDetail) => void;
  onCancel?: () => void;
  /** 「在此项目新建任务」预选的云端项目(侧栏项目组头入口) */
  initialProject?: CloudProject | null;
}) {
  const { t } = useI18n();
  const [options, setOptions] = useState<McTaskOptions | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [content, setContent] = useState("");
  const [modelId, setModelId] = useState("");
  const [hostId, setHostId] = useState("");
  const [imageId, setImageId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 仓库关联三态:project(选云端项目)/ repoUrl(手输地址)/ 都空(快速开始)。
  // 二者互斥——服务端按 project_id 复用已克隆的工作区,再给 repo_url 是矛盾输入
  const [project, setProject] = useState<CloudProject | null>(initialProject ?? null);
  const [repoUrl, setRepoUrl] = useState("");
  const [repoDraft, setRepoDraft] = useState("");
  const [repoErr, setRepoErr] = useState("");
  const [repoOpen, setRepoOpen] = useState(false);
  const repoIme = useRef(createImeGuard());

  useEffect(() => {
    let alive = true;
    mcTaskOptions()
      .then((o) => {
        if (!alive) return;
        setOptions(o);
        const model = pickDefaultCloudModel(o.models, o.plan);
        setModelId(model);
        setHostId(pickDefaultCloudHost(o.hosts, o.task_defaults?.host_id ?? "", isPublicModel(o.models, model)));
        setImageId(pickDefaultCloudImage(o.images));
      })
      .catch((e: unknown) => {
        if (alive) setLoadErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  // 外部预选项目改变(侧栏另一个项目组头再点「+」,面板已挂载不会重建):
  // 换预选即覆盖当前关联,手输地址一并让位——预选是用户刚刚的明确指令
  useEffect(() => {
    if (!initialProject) return;
    setProject(initialProject);
    setRepoUrl("");
    setRepoDraft("");
    setRepoErr("");
  }, [initialProject]);

  // 模型按档位/来源分组(基础/专业/旗舰/付费/我的/团队,移植旧 UI 口径);
  // 触发器展示「组名 / 组内名」,组内名已剥去与组头重复的档位前缀
  const modelGroups = options ? groupCloudModels(options.models, options.plan) : [];
  const selectedModel = modelGroups.flatMap((g) => g.models).find((m) => m.id === modelId);
  const selectedGroup = modelGroups.find((g) => g.models.some((m) => m.id === modelId));
  const modelTriggerLabel = selectedModel
    ? [selectedGroup?.label, groupedCloudModelLabel(selectedModel)].filter(Boolean).join(" / ")
    : undefined;
  const publicModel = options ? isPublicModel(options.models, modelId) : false;
  const hosts = options ? usableCloudHosts(options.hosts, publicModel) : [];
  const images = options?.images ?? [];

  // 公共模型只能跑公共宿主:模型切换后当前宿主可能不在可选集里,拉回默认
  const effectiveHostId = hosts.some((h) => h.id === hostId) ? hostId : (hosts[0]?.id ?? "");

  // 选项里的项目表:老服务端可能不下发,缺省当空
  const projects = options?.projects ?? [];
  const projectLabel = (p: CloudProject) => p.name || p.full_name || p.repo_url || t("cloud.new.repoProjectFallback");
  const repoTriggerLabel = project
    ? projectLabel(project)
    : repoUrl
      ? cloudRepoLabel(repoUrl)
      : t("cloud.new.repoNone");

  const clearRepo = () => {
    setProject(null);
    setRepoUrl("");
    setRepoDraft("");
    setRepoErr("");
    setRepoOpen(false);
  };
  const pickProject = (p: CloudProject) => {
    setProject(p);
    setRepoUrl("");
    setRepoDraft("");
    setRepoErr("");
    setRepoOpen(false);
  };
  const commitRepoUrl = () => {
    const value = repoDraft.trim();
    if (!value) {
      setRepoErr(t("cloud.new.error.repoEmpty"));
      return;
    }
    if (!validCloudRepoUrl(value)) {
      setRepoErr(t("cloud.new.error.repoInvalid"));
      return;
    }
    setProject(null);
    setRepoUrl(value);
    setRepoDraft(value);
    setRepoErr("");
    setRepoOpen(false);
  };

  const submit = async () => {
    if (!content.trim()) {
      setError(t("cloud.new.error.content"));
      return;
    }
    if (!modelId || !imageId) {
      setError(t("cloud.new.error.missing"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const task = await mcTaskCreate({
        content: content.trim(),
        model_id: modelId,
        host_id: effectiveHostId,
        image_id: imageId,
        // 选了项目就走 project_id(服务端复用已克隆的工作区),否则手输地址;
        // 两者都空 = 快速开始,字段整个不下发
        repo_url: project?.repo_url || repoUrl || undefined,
        project_id: project?.id || undefined,
      });
      onCreated(task);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 形态契约:本组件渲染"输入卡内容"(说明行/描述/配置行/提交行),外层卡片
  // 容器由宿主(NewTaskModal)提供;独立使用时无卡片也可成立(测试即如此)
  return (
    <div className="flex min-w-0 flex-col">
      {/* 卡头 = 「关联仓库」触发器,与本地页文件夹触发器同构同高(mt-2 + h-8):
          切页签卡头不跳动。菜单三段:不关联 / 手输地址 / 云端项目 */}
      <div
        className="relative px-2 pt-2"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRepoOpen(false);
        }}
      >
        <button
          type="button"
          className="btn btn-ghost btn-sm max-w-full justify-start gap-1.5 px-2 font-normal"
          aria-label={t("cloud.new.repo")}
          aria-expanded={repoOpen}
          title={project?.repo_url || repoUrl || t("cloud.new.repoHint")}
          onClick={() => {
            // 展开即把当前地址灌进草稿:改一版比重打一遍省事
            if (!repoOpen) setRepoDraft(repoUrl);
            setRepoErr("");
            setRepoOpen(!repoOpen);
          }}
        >
          <Cloud size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-base-content/60" />
          <span
            className={`min-w-0 truncate text-xs ${project || repoUrl ? "font-semibold" : "text-base-content/50"}`}
          >
            {repoTriggerLabel}
          </span>
          <ChevronDown
            size={12}
            strokeWidth={1.75}
            aria-hidden
            className={`shrink-0 text-base-content/50 transition-transform duration-150 ${repoOpen ? "rotate-180" : ""}`}
          />
        </button>
        {repoOpen && (
          <ul
            aria-label={t("cloud.new.repo")}
            className="absolute start-2 top-full z-20 mt-1 flex max-h-80 w-96 max-w-[calc(100%-1rem)] flex-col overflow-x-hidden overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1.5 shadow-lg"
          >
            <li>
              <button
                type="button"
                aria-current={!project && !repoUrl ? "true" : undefined}
                className={`btn btn-ghost btn-sm w-full justify-start gap-2 px-2 font-normal ${!project && !repoUrl ? "btn-active" : ""}`}
                onClick={clearRepo}
              >
                <Cloud size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-base-content/50" />
                <span className="min-w-0 flex-1 truncate text-start text-xs">{t("cloud.new.repoNone")}</span>
                {!project && !repoUrl && <Check size={12} strokeWidth={2} aria-hidden className="shrink-0 text-primary" />}
              </button>
            </li>
            <li aria-hidden className="my-1 border-t border-base-300" />
            <li aria-hidden className="px-2 pt-1 pb-0.5 text-[10px] font-bold tracking-wider text-base-content/40">
              {t("cloud.new.repoManual")}
            </li>
            <li className="flex items-center gap-1.5 px-2 pb-1">
              <input
                className={`input input-xs flex-1 font-mono ${repoErr ? "input-error" : ""}`}
                aria-label={t("cloud.new.repoManual")}
                placeholder="https://github.com/owner/repo.git"
                value={repoDraft}
                onChange={(e) => {
                  setRepoDraft(e.target.value);
                  setRepoErr("");
                }}
                onCompositionEnd={(e) => repoIme.current.markEnd(e.timeStamp)}
                onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                  // 输入态按键不外溢(Esc 属于本菜单,别漏给关页面的全局链)
                  e.stopPropagation();
                  if (e.key === "Escape") return setRepoOpen(false);
                  if (e.key !== "Enter") return;
                  if (repoIme.current.isImeEnter(e.timeStamp, e.nativeEvent.isComposing)) return;
                  e.preventDefault();
                  commitRepoUrl();
                }}
              />
              <button type="button" className="btn btn-xs" disabled={!repoDraft.trim()} onClick={commitRepoUrl}>
                {t("cloud.new.repoUse")}
              </button>
            </li>
            {repoErr && (
              <li role="alert" className="px-2 pb-1 text-[10px] text-error">
                {repoErr}
              </li>
            )}
            {projects.length > 0 && (
              <>
                <li aria-hidden className="my-1 border-t border-base-300" />
                <li aria-hidden className="px-2 pt-1 pb-0.5 text-[10px] font-bold tracking-wider text-base-content/40">
                  {t("cloud.new.repoProjects")}
                </li>
                {projects.map((p) => (
                  <li key={p.id || p.repo_url}>
                    <button
                      type="button"
                      aria-label={projectLabel(p)}
                      aria-current={project?.id === p.id ? "true" : undefined}
                      className={`btn btn-ghost btn-sm h-auto w-full justify-start gap-2 px-2 py-1.5 font-normal ${project?.id === p.id ? "btn-active" : ""}`}
                      onClick={() => pickProject(p)}
                    >
                      <Folder size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-base-content/50" />
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                        <span className="max-w-full truncate text-xs font-medium">{projectLabel(p)}</span>
                        {p.repo_url && (
                          <span className="max-w-full truncate font-mono text-[10px] text-base-content/50">{p.repo_url}</span>
                        )}
                      </span>
                      {project?.id === p.id && <Check size={12} strokeWidth={2} aria-hidden className="shrink-0 text-primary" />}
                    </button>
                  </li>
                ))}
              </>
            )}
          </ul>
        )}
      </div>

      {loadErr && (
        <div role="alert" className="mx-3 my-3 alert alert-error alert-soft py-1.5 text-xs">
          {t("cloud.new.optionsFailed", { reason: loadErr })}
        </div>
      )}
      {!options && !loadErr && (
        // min-h ≈ 描述区+工具行的高度:选项到达/页签切换时卡片不塌陷回弹
        <div className="flex min-h-36 items-center justify-center gap-2 px-4 text-xs text-base-content/50">
          <span className="loading loading-spinner loading-xs" aria-hidden />
          {t("cloud.new.loading")}
        </div>
      )}

      {options && (
        <>
          <textarea
            className="textarea min-h-24 w-full resize-none border-0 bg-transparent px-4 text-sm leading-relaxed shadow-none focus:outline-none"
            rows={4}
            autoFocus
            aria-label={t("cloud.new.content")}
            placeholder={t("cloud.new.contentPlaceholder")}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          {/* 工具行(与本地页同构):运行配置选择器在左,提交钮同行在右 */}
          <div className="flex min-w-0 items-center gap-1 px-2.5 pb-2.5">
            <OptionMenu
              ariaLabel={t("cloud.new.model")}
              value={modelId}
              triggerLabel={modelTriggerLabel}
              onPick={setModelId}
              sections={modelGroups.map((g) => ({
                key: g.key,
                label: g.label,
                badge: g.badge,
                options: g.models.map((m) => ({
                  value: m.id ?? "",
                  label: groupedCloudModelLabel(m),
                  disabled: m.locked,
                })),
              }))}
            />
            <OptionMenu
              ariaLabel={t("cloud.new.host")}
              value={effectiveHostId}
              onPick={setHostId}
              disabled={publicModel}
              options={hosts.map((hostItem) => ({ value: hostItem.id ?? "", label: cloudHostLabel(hostItem) }))}
            />
            <OptionMenu
              ariaLabel={t("cloud.new.image")}
              value={imageId}
              onPick={setImageId}
              options={images.map((img) => ({ value: img.id ?? "", label: cloudImageLabel(img) }))}
            />
            <span className="min-w-0 flex-1" />
            {onCancel && (
              <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={onCancel}>
                {t("cloud.new.cancel")}
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary btn-sm shrink-0 gap-1.5"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy && <span className="loading loading-spinner loading-xs" aria-hidden />}
              {t("cloud.new.submit")}
              {!busy && <SendHorizontal size={12} strokeWidth={2} aria-hidden />}
            </button>
          </div>
        </>
      )}

      {error && (
        <div role="alert" className="mx-3 mb-3 alert alert-error alert-soft py-1.5 text-xs">
          {error}
        </div>
      )}
    </div>
  );
}
