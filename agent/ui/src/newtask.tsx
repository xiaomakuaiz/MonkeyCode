// 新建任务视图:居中卡片(文件夹选择 + 任务输入 + 本地/云端 + 模型 + 开始)。
// 布局与数值取自设计稿 New Task 屏;云端执行后端未上线,选中仅展示提示,仍建本地会话。
import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { basename, isImeEnter, markImeEnd, ModelPicker } from "./chat";
import { MONO } from "./components";
import { inDesktopShell, pickDirectory } from "./client";
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
  onDirChange,
  onTextChange,
  onModelChange,
  onCreate,
}: {
  dir: string;
  recentDirs: string[];
  text: string;
  models: ModelInfo[];
  model: string;
  busy: boolean;
  err: string;
  offerCreate: boolean;
  onDirChange: (dir: string) => void;
  onTextChange: (v: string) => void;
  onModelChange: (name: string) => void;
  onCreate: (createDir?: boolean) => void;
}) {
  const [folderOpen, setFolderOpen] = useState(false);
  const [mode, setMode] = useState<"local" | "cloud">("local");
  const [manualDir, setManualDir] = useState("");

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
      onCreate();
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
    boxShadow: active ? "0 1px 3px rgba(0,0,0,.1)" : "none",
    fontSize: 11.5,
    fontWeight: 700,
    color: active ? fg : "var(--t5)",
    cursor: "pointer",
    userSelect: "none",
  });

  const dropdownItem: CSSProperties = {
    border: "none",
    background: "transparent",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "6px 9px",
    borderRadius: 6,
    textAlign: "left",
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ margin: "0 auto", width: "100%", maxWidth: 640, padding: "max(40px,14vh) 36px 32px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: 13,
              background: "var(--card)",
              boxShadow: "0 1px 2px rgba(30,45,38,.08),0 6px 18px rgba(30,45,38,.1),inset 0 0 0 1px rgba(31,138,91,.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <img src={logoUrl} alt="" draggable={false} style={{ width: 28, height: 28, borderRadius: 7 }} />
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.2, marginTop: 6 }}>开始一个新任务</div>
          <div style={{ fontSize: 12, color: "var(--t6)" }}>告诉我要做什么,剩下的交给我</div>
        </div>

        <div
          style={{
            background: "rgba(255,255,255,.94)",
            border: "1px solid var(--line)",
            borderRadius: 16,
            boxShadow: "0 10px 36px rgba(30,45,38,.12)",
            display: "flex",
            flexDirection: "column",
            position: "relative",
          }}
        >
          <div style={{ padding: "8px 8px 0", position: "relative" }}>
            {mode === "cloud" ? (
              <button
                title="云端任务基于代码仓库运行"
                style={{ display: "flex", alignItems: "center", gap: 7, height: 28, padding: "0 9px", border: "none", borderRadius: 8, background: "transparent", cursor: "pointer", maxWidth: "100%" }}
                className="hv"
              >
                <IconCloud size={13} color="var(--t3)" />
                <span style={{ fontSize: 12, color: "var(--t5)" }}>连接代码仓库…</span>
                <IconChevronDown color="var(--t5)" />
              </button>
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
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {basename(dir)}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--t5)", flex: "none" }}>文件夹里工作</span>
                  <IconChevronDown color="var(--t5)" style={{ transform: folderOpen ? "rotate(180deg)" : "none", transition: "transform .15s ease" }} />
                </button>
                {folderOpen && (
                  <>
                    <div style={{ position: "fixed", inset: 0, zIndex: 29 }} onClick={() => setFolderOpen(false)} />
                    <div
                      style={{
                        position: "absolute",
                        top: 34,
                        left: 8,
                        zIndex: 30,
                        background: "var(--pop)",
                        border: "1px solid var(--line)",
                        borderRadius: 10,
                        boxShadow: "var(--shadow)",
                        padding: 4,
                        display: "flex",
                        flexDirection: "column",
                        minWidth: 280,
                        maxWidth: 380,
                      }}
                    >
                      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--t6)", padding: "5px 9px 3px" }}>
                        最近用过的文件夹
                      </span>
                      {recentDirs.map((p) => (
                        <button key={p} className="hv" onClick={() => pick(p)} style={dropdownItem}>
                          <IconFolder color="var(--t5)" />
                          <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--t2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {basename(p)}
                            </span>
                            <span style={{ fontSize: 10.5, fontFamily: MONO, color: "var(--t6)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {p}
                            </span>
                          </span>
                          {p === dir && <IconCheck size={11} color="var(--acc)" strokeWidth={1.6} />}
                        </button>
                      ))}
                      <span style={{ height: 1, background: "var(--line2)", margin: "4px 6px" }} />
                      {inDesktopShell() && (
                        <button className="hv" onClick={() => void browse()} style={dropdownItem}>
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
            <span style={{ display: "flex", background: "rgba(120,130,125,.1)", borderRadius: 13, padding: 2, flex: "none" }}>
              <span onClick={() => setMode("local")} title="跑在这台电脑上,直接读写本地文件,每步权限逐一确认" style={segItem(mode === "local", "var(--acc)")}>
                <IconMonitor size={11} color={mode === "local" ? "var(--acc)" : "var(--t5)"} strokeWidth={1.4} />
                本地
              </span>
              <span onClick={() => setMode("cloud")} title="跑在云上服务器,关掉客户端也继续" style={segItem(mode === "cloud", "var(--warn)")}>
                <IconCloud size={11} color={mode === "cloud" ? "var(--warn)" : "var(--t5)"} />
                云端
              </span>
            </span>
            <ModelPicker models={models} current={model} onPick={onModelChange} />
            <span style={{ flex: 1 }} />
            <button
              className="hv-acc"
              onClick={() => onCreate()}
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
                boxShadow: "0 2px 8px rgba(31,138,91,.25)",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? "创建中…" : "开始任务"}
              <IconSend size={11} />
            </button>
          </div>

          {mode === "cloud" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 10px 10px", padding: "8px 11px", borderRadius: 9, background: "rgba(232,193,90,.13)", border: "1px solid rgba(161,98,7,.18)" }}>
              <IconInfo color="#a16207" />
              <span style={{ fontSize: 12, color: "#7c5210", lineHeight: 1.5 }}>
                云端运行还在准备中,预计下个版本上线。这个任务会先在本地跑,之后可以随时切换。
              </span>
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
