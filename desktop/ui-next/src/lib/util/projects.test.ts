import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionMeta } from "@/lib/ipc/sessions";
import {
  groupSessions,
  projectKey,
  projectName,
  readArchivedProjects,
  readProjectOrder,
  reorderKeys,
  writeProjectOrder,
} from "./projects";

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
});
afterEach(() => vi.unstubAllGlobals());

const meta = (over: Partial<SessionMeta> & { id: string; workdir: string }): SessionMeta => ({
  title: over.id,
  model: "m",
  turns: 0,
  status: "idle",
  ...over,
});

describe("项目 key 归一(跨平台契约)", () => {
  it("反斜杠转正斜杠、去尾斜杠、根目录除外", () => {
    expect(projectKey("C:\\work\\demo\\")).toBe("C:/work/demo");
    expect(projectKey("/home/a/b///")).toBe("/home/a/b");
    expect(projectKey("/")).toBe("/");
    expect(projectName("C:\\work\\demo\\")).toBe("demo");
  });

  it("mc.projectOrder 读写去重且经归一;脏 JSON 回落空", () => {
    writeProjectOrder(["/a/", "\\a", "/b"]);
    expect(JSON.parse(store.get("mc.projectOrder") ?? "")).toEqual(["/a", "/b"]);
    store.set("mc.projectOrder", "not json");
    expect(readProjectOrder()).toEqual([]);
    store.set("mc.archivedProjects", JSON.stringify(["/x/", 42]));
    expect([...readArchivedProjects()]).toEqual(["/x"]);
  });
});

describe("拖拽落点", () => {
  it("移到目标之前;目标为 null/未知移到末尾;拖自己无变化", () => {
    expect(reorderKeys(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(reorderKeys(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(reorderKeys(["a", "b", "c"], "a", "gone")).toEqual(["b", "c", "a"]);
    expect(reorderKeys(["a", "b", "c"], "b", "b")).toEqual(["a", "c", "b"]);
  });
});

describe("分组", () => {
  const sessions = [
    meta({ id: "a1", workdir: "/p/alpha", updated_at: "2026-08-01" }),
    meta({ id: "b1", workdir: "/p/beta", updated_at: "2026-08-03" }),
    meta({ id: "a2", workdir: "/p/alpha/", updated_at: "2026-08-02", archived: true }),
    meta({ id: "c1", workdir: "/p/gamma", updated_at: "2026-07-01" }),
  ];

  it("按归一 key 聚合;无手动序时按组内最近活跃排序;归档会话入组内折叠区", () => {
    const { projects } = groupSessions(sessions, [], new Set());
    expect(projects.map((p) => p.name)).toEqual(["beta", "alpha", "gamma"]);
    const alpha = projects[1];
    expect(alpha?.sessions.map((s) => s.id)).toEqual(["a1"]);
    expect(alpha?.archivedSessions.map((s) => s.id)).toEqual(["a2"]);
  });

  it("手动序优先,未入序项目按活跃度追尾;归档项目单列", () => {
    const { projects } = groupSessions(sessions, ["/p/gamma", "/p/alpha"], new Set());
    expect(projects.map((p) => p.name)).toEqual(["gamma", "alpha", "beta"]);

    const grouped = groupSessions(sessions, [], new Set(["/p/beta"]));
    expect(grouped.projects.map((p) => p.name)).toEqual(["alpha", "gamma"]);
    expect(grouped.archivedProjects.map((p) => p.name)).toEqual(["beta"]);
  });
});
