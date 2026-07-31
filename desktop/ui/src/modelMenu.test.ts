import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildModelMenu,
  readLastTaskModel,
  readRecentModels,
  rememberLastTaskModel,
  shouldShowModelExtras,
  touchRecentModel,
} from "./modelMenu";
import { SOURCE_BAIZHI, SOURCE_MONKEYCODE, type ModelInfo } from "./types";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

afterEach(() => vi.unstubAllGlobals());

const m = (name: string, source?: string, def = false): ModelInfo => ({ name, default: def, source });

describe("最近使用与上次选择的存取", () => {
  it("坏 JSON / 非数组 / 混入非字符串都容错为剔除或空", () => {
    localStorage.setItem("mc.recentModels", "{broken");
    expect(readRecentModels()).toEqual([]);
    localStorage.setItem("mc.recentModels", '"just-a-string"');
    expect(readRecentModels()).toEqual([]);
    localStorage.setItem("mc.recentModels", '["a", 7, null, "b", "a", ""]');
    expect(readRecentModels()).toEqual(["a", "b"]);
  });

  it("touchRecentModel 去重置顶且上限 3", () => {
    for (const name of ["a", "b", "c", "d"]) touchRecentModel(name);
    expect(readRecentModels()).toEqual(["d", "c", "b"]);
    touchRecentModel("b"); // 重选置顶,不重复
    expect(readRecentModels()).toEqual(["b", "d", "c"]);
    touchRecentModel(""); // 空名不入账
    expect(readRecentModels()).toEqual(["b", "d", "c"]);
  });

  it("lastTaskModel 缺省为空串,可往返", () => {
    expect(readLastTaskModel()).toBe("");
    rememberLastTaskModel("会员模型");
    expect(readLastTaskModel()).toBe("会员模型");
    rememberLastTaskModel(""); // 空名不覆盖
    expect(readLastTaskModel()).toBe("会员模型");
  });
});

describe("buildModelMenu", () => {
  const models = [
    m("手工模型"),
    m("claude-x", SOURCE_BAIZHI, true),
    m("monkeycode-pro/deepseek-pro", SOURCE_MONKEYCODE),
  ];

  it("过滤匹配 name 与来源组名(大小写不敏感),组结构保留", () => {
    expect(buildModelMenu(models, [], "CLAUDE").groups).toEqual([
      { label: "百智云", items: [models[1]] },
    ]);
    // 组名命中 → 整组显示
    const byGroup = buildModelMenu(models, [], "百智");
    expect(byGroup.groups.map((g) => g.label)).toEqual(["百智云"]);
    const byMc = buildModelMenu(models, [], "monkeycode");
    expect(byMc.groups.map((g) => g.label)).toEqual(["MonkeyCode 会员"]);
    expect(buildModelMenu(models, [], "不存在").groups).toEqual([]);
  });

  it("自定义组恒前,其余按首现顺序", () => {
    const shuffled = [models[2], models[1], models[0]];
    expect(buildModelMenu(shuffled, [], "").groups.map((g) => g.label)).toEqual([
      "自定义",
      "MonkeyCode 会员",
      "百智云",
    ]);
  });

  it("最近组按记忆保序、剔除已下线,与来源组不去重;过滤时隐藏", () => {
    const { recent, groups } = buildModelMenu(models, ["claude-x", "已下线", "手工模型"], "");
    expect(recent.map((x) => x.name)).toEqual(["claude-x", "手工模型"]);
    // 不去重:来源组仍完整
    expect(groups.flatMap((g) => g.items.map((x) => x.name))).toContain("claude-x");
    expect(buildModelMenu(models, ["claude-x"], "claude").recent).toEqual([]);
  });
});

describe("shouldShowModelExtras", () => {
  it("超过 6 个模型才显示过滤框与最近组", () => {
    expect(shouldShowModelExtras(6)).toBe(false);
    expect(shouldShowModelExtras(7)).toBe(true);
  });
});
