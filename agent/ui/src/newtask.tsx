// 新建任务视图:居中卡片(文件夹选择 + 任务输入 + 本地/云端 + 模型 + 开始)。
// 布局与数值取自设计稿 New Task 屏。云端模式:选仓库(可不选=快速开始)+ 云端模型,
// 经内核代理真实创建 monkeycode 云端任务,成功后进桌面内详情视图跟看。
import { useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import { basename, isImeEnter, markImeEnd, ModelPicker } from "./chat";
import { MONO } from "./components";
import { inDesktopShell, mcTaskCreate, mcTaskOptions, pickDirectory, type CloudTask } from "./client";
import {
  cloudModelLabel,
  pickDefaultCloudImage,
  pickDefaultCloudModel,
  usableCloudModels,
  type McCloudProject,
  type McTaskOptions,
} from "./cloud";
import {
  IconCheck,
  IconChevronDown,
  IconCloud,
  IconFolder,
  IconInfo,
  IconMonitor,
  IconPlus,
  IconSend,
} from "./icons";
import logoUrl from "./logo.png";
import type { ModelInfo } from "./types";

export function NewTaskView({
  dir,
  recentDirs,
  text,
  models,
  model,
  busy,
  err,
  offerCreate,
  cloudReady,
  onDirChange,
  onTextChange,
  onModelChange,
  onCreate,
  onCloudCreated,
}: {
  dir: string;
  recentDirs: string[];
  text: string;
  models: ModelInfo[];
  model: string;
  busy: boolean;
  err: string;
  offerCreate: boolean;
  /** monkeycode 云端账号已同步(云端派发的前提) */
  cloudReady: boolean;
  onDirChange: (dir: string) => void;
  onTextChange: (v: string) => void;
  onModelChange: (name: string) => void;
  onCreate: (createDir?: boolean) => void;
  /** 云端任务创建成功:App 打开桌面内详情视图跟看 */
  onCloudCreated: (t: CloudTask) => void;
}) {
  const [folderOpen, setFolderOpen] = useState(false);
  const [mode, setMode] = useState<"local" | "cloud">("local");
  const [manualDir, setManualDir] = useState("");

  // ===== 云端模式:选项数据(模型/镜像/项目)+ 选择态 =====
  const [cloudOpts, setCloudOpts] = useState<McTaskOptions | null>(null);
  const [cloudErr, setCloudErr] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudModelId, setCloudModelId] = useState("");
  const [cloudImageId, setCloudImageId] = useState("");
  const [cloudProject, setCloudProject] = useState<McCloudProject | null>(null);
  const [repoOpen, setRepoOpen] = useState(false);
  const [cloudModelOpen, setCloudModelOpen] = useState(false);

  useEffect(() => {
    if (mode !== "cloud" || !cloudReady || cloudOpts) return;
    let alive = true;
    mcTaskOptions()
      .then((o) => {
        if (!alive) return;
        setCloudOpts(o);
        setCloudModelId(pickDefaultCloudModel(o.models, o.plan));
        setCloudImageId(pickDefaultCloudImage(o.images));
      })
      .catch((e) => alive && setCloudErr("云端选项加载失败: " + (e instanceof Error ? e.message : String(e))));
    return () => {
      alive = false;
    };
  }, [mode, cloudReady, cloudOpts]);

  const cloudModels = cloudOpts ? usableCloudModels(cloudOpts.models, cloudOpts.plan) : [];
  const cloudModelName = (() => {
    const m = cloudOpts?.models.find((x) => x.id === cloudModelId);
    return m ? cloudModelLabel(m) : "模型";
  })();

  const createCloud = async () => {
    const content = text.trim();
    if (cloudBusy) return;
    if (!content) {
      setCloudErr("云端任务需要先描述要做的事");
      return;
    }
    if (!cloudModelId || !cloudImageId) {
      setCloudErr(cloudOpts ? "云端模型/镜像不可用,请稍后重试" : "云端选项还没加载好,请稍候");
      return;
    }
    setCloudBusy(true);
    setCloudErr("");
    try {
      const task = await mcTaskCreate({
        content,
        model_id: cloudModelId,
        image_id: cloudImageId,
        repo_url: cloudProject?.repo_url || undefined,
        project_id: cloudProject?.id || undefined,
      });
      if (!task?.id) throw new Error("云端未返回任务 ID");
      onTextChange("");
      onCloudCreated({ id: task.id, content, status: task.status ?? "pending", title: task.title, summary: task.summary });
    } catch (e) {
      setCloudErr("云端任务创建失败: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCloudBusy(false);
    }
  };

  const submit = () => {
    if (mode === "cloud") void createCloud();
    else onCreate();
  };

  const pick = (p: string) => {
    onDirChange(p);
    setFolderOpen(false);
  };

  const browse = async () => {
    const p = await pickDirectory();
    if (p) pick(p);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !isImeEnter(e)) {
      e.preventDefault();
      submit();
    }
  };

  const segItem = (active: boolean, fg: string): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 5,
    height: 22,
    padding: "0 10px",
    borderRadius: 11,
    background: active ? "var(--card)" : "transparent",
    boxShadow: active ? "var(--segSh)" : "none",
    fontSize: 11.5,
    fontWeight: 700,
    color: active ? fg : "var(--t5)",
    cursor: "pointer",
    userSelect: "none",
  });

  return (
    <div style={{ flex: 1, overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ margin: "0 auto", width: "100%", maxWidth: 640, padding: "max(40px,14vh) 36px 32px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <img src={logoUrl} alt="" draggable={false} style={{ width: 52, height: 52 }} />
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.2, marginTop: 6 }}>开始一个新任务</div>
          <div style={{ fontSize: 12, color: "var(--t6)" }}>告诉我要做什么,剩下的交给我</div>
        </div>

        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: 16,
            boxShadow: "var(--panelShLg)",
            display: "flex",
            flexDirection: "column",
            position: "relative",
          }}
        >
          <div style={{ padding: "8px 8px 0", position: "relative" }}>
            {mode === "cloud" ? (
              <>
                <button
                  title="云端任务可关联代码仓库,也可不关联直接对话"
                  className="hv"
                  onClick={() => setRepoOpen(!repoOpen)}
                  style={{ display: "flex", alignItems: "center", gap: 7, height: 28, padding: "0 9px", border: "none", borderRadius: 8, background: repoOpen ? "var(--hov)" : "transparent", cursor: "pointer", maxWidth: "100%" }}
                >
                  <IconCloud size={13} color="var(--t3)" />
                  <span className="ellipsis" style={{ fontSize: 12, fontWeight: cloudProject ? 600 : 400, color: cloudProject ? "var(--t2)" : "var(--t5)" }}>
                    {cloudProject ? cloudProject.name || cloudProject.full_name || cloudProject.repo_url : "不关联仓库(快速开始)"}
                  </span>
                  <IconChevronDown color="var(--t5)" style={{ transform: repoOpen ? "rotate(180deg)" : "none", transition: "transform .15s ease" }} />
                </button>
                {repoOpen && (
                  <>
                    <div className="backdrop" onClick={() => setRepoOpen(false)} />
                    <div className="pop" style={{ position: "absolute", top: 34, left: 8, borderRadius: 10, minWidth: 280, maxWidth: 400, maxHeight: 320, overflowY: "auto" }}>
                      <button className="hv menu-item" onClick={() => { setCloudProject(null); setRepoOpen(false); }} style={{ gap: 9 }}>
                        <IconCloud size={12} color="var(--t5)" />
                        <span style={{ flex: 1, fontSize: 12.5, color: "var(--t2)" }}>不关联仓库(快速开始)</span>
                        {!cloudProject && <IconCheck size={11} color="var(--acc)" strokeWidth={1.6} />}
                      </button>
                      {(cloudOpts?.projects.length ?? 0) > 0 && (
                        <>
                          <span style={{ height: 1, background: "var(--line2)", margin: "4px 6px" }} />
                          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--t6)", padding: "5px 9px 3px" }}>
                            云端项目
                          </span>
                          {cloudOpts!.projects.map((p) => (
                            <button key={p.id || p.repo_url} className="hv menu-item" onClick={() => { setCloudProject(p); setRepoOpen(false); }} style={{ gap: 9 }}>
                              <IconFolder color="var(--t5)" />
                              <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                                <span className="ellipsis" style={{ fontSize: 12.5, fontWeight: 500, color: "var(--t2)" }}>
                                  {p.name || p.full_name || "项目"}
                                </span>
                                {p.repo_url && (
                                  <span className="ellipsis" style={{ fontSize: 10.5, fontFamily: MONO, color: "var(--t6)" }}>{p.repo_url}</span>
                                )}
                              </span>
                              {cloudProject?.id === p.id && <IconCheck size={11} color="var(--acc)" strokeWidth={1.6} />}
                            </button>
                          ))}
                        </>
                      )}
                      {cloudOpts && cloudOpts.projects.length === 0 && (
                        <span style={{ fontSize: 11, color: "var(--t6)", padding: "3px 9px 6px" }}>云端还没有项目;不关联仓库也能直接开跑</span>
                      )}
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <button
                  className="hv"
                  onClick={() => setFolderOpen(!folderOpen)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    height: 28,
                    padding: "0 9px",
                    border: "none",
                    borderRadius: 8,
                    background: folderOpen ? "var(--hov)" : "transparent",
                    cursor: "pointer",
                    maxWidth: "100%",
                  }}
                >
                  <IconFolder />
                  <span style={{ fontSize: 12, color: "var(--t5)", flex: "none" }}>在</span>
                  <span className="ellipsis" style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)" }}>
                    {basename(dir)}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--t5)", flex: "none" }}>文件夹里工作</span>
                  <IconChevronDown color="var(--t5)" style={{ transform: folderOpen ? "rotate(180deg)" : "none", transition: "transform .15s ease" }} />
                </button>
                {folderOpen && (
                  <>
                    <div className="backdrop" onClick={() => setFolderOpen(false)} />
                    <div className="pop" style={{ position: "absolute", top: 34, left: 8, borderRadius: 10, minWidth: 280, maxWidth: 380 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--t6)", padding: "5px 9px 3px" }}>
                        最近用过的文件夹
                      </span>
                      {recentDirs.map((p) => (
                        <button key={p} className="hv menu-item" onClick={() => pick(p)} style={{ gap: 9 }}>
                          <IconFolder color="var(--t5)" />
                          <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                            <span className="ellipsis" style={{ fontSize: 12.5, fontWeight: 500, color: "var(--t2)" }}>
                              {basename(p)}
                            </span>
                            <span className="ellipsis" style={{ fontSize: 10.5, fontFamily: MONO, color: "var(--t6)" }}>
                              {p}
                            </span>
                          </span>
                          {p === dir && <IconCheck size={11} color="var(--acc)" strokeWidth={1.6} />}
                        </button>
                      ))}
                      <span style={{ height: 1, background: "var(--line2)", margin: "4px 6px" }} />
                      {inDesktopShell() && (
                        <button className="hv menu-item" onClick={() => void browse()} style={{ gap: 9 }}>
                          <IconPlus size={12} color="var(--t3)" />
                          <span style={{ fontSize: 12, color: "var(--t3)" }}>选择其他文件夹…</span>
                        </button>
                      )}
                      {/* 手动输入(浏览器模式没有原生目录选择;壳内也可直接粘贴路径) */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px 4px 9px" }}>
                        <input
                          value={manualDir}
                          onChange={(e) => setManualDir(e.target.value)}
                          onCompositionEnd={markImeEnd}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !isImeEnter(e) && manualDir.trim()) pick(manualDir.trim());
                          }}
                          placeholder="或输入路径,如 ~/dev/project"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            border: "1px solid var(--line)",
                            borderRadius: 6,
                            padding: "5px 8px",
                            font: "11px " + MONO,
                            color: "var(--t1)",
                            outline: "none",
                            background: "var(--card)",
                          }}
                        />
                        <button
                          className="hv2"
                          onClick={() => manualDir.trim() && pick(manualDir.trim())}
                          style={{ border: "none", background: "var(--hov)", borderRadius: 6, padding: "5px 10px", fontSize: 11.5, color: "var(--t2)", cursor: "pointer", flex: "none" }}
                        >
                          确定
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <textarea
            value={text}
            autoFocus
            rows={4}
            onChange={(e) => onTextChange(e.target.value)}
            onCompositionEnd={markImeEnd}
            onKeyDown={onKey}
            placeholder="描述要做的事…留空则先建会话"
            style={{
              border: "none",
              outline: "none",
              resize: "none",
              background: "transparent",
              color: "var(--t1)",
              padding: "9px 17px 4px",
              fontSize: 13.5,
              lineHeight: 1.55,
              width: "100%",
            }}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px 11px" }}>
            <span style={{ display: "flex", background: "var(--segBg)", borderRadius: 13, padding: 2, flex: "none" }}>
              <span onClick={() => setMode("local")} title="跑在这台电脑上,直接读写本地文件,每步权限逐一确认" style={segItem(mode === "local", "var(--acc)")}>
                <IconMonitor size={11} color={mode === "local" ? "var(--acc)" : "var(--t5)"} strokeWidth={1.4} />
                本地
              </span>
              <span onClick={() => setMode("cloud")} title="跑在云上服务器,关掉客户端也继续" style={segItem(mode === "cloud", "var(--warn)")}>
                <IconCloud size={11} color={mode === "cloud" ? "var(--warn)" : "var(--t5)"} />
                云端
              </span>
            </span>
            {mode === "cloud" ? (
              <span style={{ position: "relative", flex: "none" }}>
                <button
                  className="hv"
                  title="云端模型(按订阅档位)"
                  onClick={() => setCloudModelOpen(!cloudModelOpen)}
                  style={{ display: "flex", alignItems: "center", gap: 5, height: 24, padding: "0 8px", border: "none", borderRadius: 7, background: cloudModelOpen ? "var(--hov)" : "transparent", cursor: "pointer", fontSize: 11.5, color: "var(--t3)", maxWidth: 200 }}
                >
                  <span className="ellipsis">{cloudModelName}</span>
                  <IconChevronDown color="var(--t5)" />
                </button>
                {cloudModelOpen && (
                  <>
                    <div className="backdrop" onClick={() => setCloudModelOpen(false)} />
                    <div className="pop" style={{ position: "absolute", bottom: 30, left: 0, borderRadius: 10, minWidth: 210, maxHeight: 280, overflowY: "auto" }}>
                      {cloudModels.map((m) => (
                        <button key={m.id} className="hv menu-item" onClick={() => { setCloudModelId(m.id!); setCloudModelOpen(false); }} style={{ gap: 8 }}>
                          <span className="ellipsis" style={{ flex: 1, fontSize: 12.5, color: "var(--t2)" }}>{cloudModelLabel(m)}</span>
                          {m.id === cloudModelId && <IconCheck size={11} color="var(--acc)" strokeWidth={1.6} />}
                        </button>
                      ))}
                      {cloudModels.length === 0 && (
                        <span style={{ fontSize: 11.5, color: "var(--t6)", padding: "6px 9px" }}>{cloudOpts ? "没有可用的云端模型" : "加载中…"}</span>
                      )}
                    </div>
                  </>
                )}
              </span>
            ) : (
              <ModelPicker models={models} current={model} onPick={onModelChange} />
            )}
            <span style={{ flex: 1 }} />
            <button
              className="hv-acc"
              onClick={submit}
              style={{
                height: 30,
                border: "none",
                borderRadius: 9,
                background: "var(--acc)",
                color: "var(--onAcc)",
                fontSize: 12.5,
                fontWeight: 700,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "0 15px",
                flex: "none",
                boxShadow: "var(--accSh)",
                opacity: busy || cloudBusy ? 0.6 : 1,
              }}
            >
              {busy || cloudBusy ? "创建中…" : "开始任务"}
              <IconSend size={11} />
            </button>
          </div>

          {mode === "cloud" && !cloudReady && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 10px 10px", padding: "8px 11px", borderRadius: 9, background: "var(--warnBg)", border: "1px solid var(--warnBd2)" }}>
              <IconInfo color="var(--warn)" />
              <span style={{ fontSize: 12, color: "var(--warnT)", lineHeight: 1.5 }}>
                云端任务需要先登录百智云账号(设置 → 百智云账号),登录后自动同步。
              </span>
            </div>
          )}
          {mode === "cloud" && cloudReady && cloudErr && (
            <div style={{ margin: "0 10px 10px", padding: "8px 11px", borderRadius: 9, background: "var(--warnBg)", border: "1px solid var(--warnBd2)", fontSize: 12, color: "var(--warnT)", lineHeight: 1.5 }}>
              {cloudErr}
            </div>
          )}
        </div>

        {err && (
          <div style={{ fontSize: 12, color: "var(--err)", lineHeight: 1.6 }}>
            {err}
            {offerCreate && (
              <span className="hv-t1" onClick={() => onCreate(true)} style={{ cursor: "pointer", color: "var(--warn)", marginLeft: 8 }}>
                创建该目录并继续 →
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
