import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildModelMenu,
  modelDisplay,
  modelDisplayByName,
  readLastTaskModel,
  readRecentModels,
  rememberLastTaskModel,
  shouldShowModelExtras,
  stripTierPrefix,
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

describe("会员长名的展示投影(对齐 Web 前缀口径,纯展示层)", () => {
  it("stripTierPrefix 只剥斜杠形前缀,剥空回落原名", () => {
    expect(stripTierPrefix("monkeycode-pro/deepseek-pro")).toBe("deepseek-pro");
    expect(stripTierPrefix("Monkeycode-Ultra/Claude-X")).toBe("Claude-X");
    // 连字符形整串可能就是真实模型 id,不剥
    expect(stripTierPrefix("monkeycode-pro-claude")).toBe("monkeycode-pro-claude");
    expect(stripTierPrefix("monkeycode-pro/")).toBe("monkeycode-pro/");
    expect(stripTierPrefix("some-other-model")).toBe("some-other-model");
  });

  it("modelDisplay:会员条目短名 + 档位(档位从底层 model 判);其余来源原样", () => {
    expect(
      modelDisplay({ name: "monkeycode-pro/deepseek-pro", model: "monkeycode-pro/deepseek-pro", source: SOURCE_MONKEYCODE }),
    ).toEqual({ label: "deepseek-pro", tier: "专业" });
    // remark 别名:短名 = remark,档位仍能从 model 判出
    expect(
      modelDisplay({ name: "深度求索", model: "monkeycode-ultra/ds", source: SOURCE_MONKEYCODE }),
    ).toEqual({ label: "深度求索", tier: "旗舰" });
    // 会员组里的服务端自定义模型:无前缀 → 原样、无档位
    expect(
      modelDisplay({ name: "some-other-model", model: "some-other-model", source: SOURCE_MONKEYCODE }),
    ).toEqual({ label: "some-other-model", tier: undefined });
    // 手工条目取了会员形状的名字:不投影(name 是引擎键,别误打会员档)
    expect(modelDisplay({ name: "monkeycode-pro/x" })).toEqual({ label: "monkeycode-pro/x" });
    // 下线模型兜底项没有 model 字段:容缺
    expect(modelDisplay({ name: "x", source: SOURCE_MONKEYCODE })).toEqual({ label: "x", tier: undefined });
  });

  it("modelDisplayByName:回查条目投影,查不到原样", () => {
    const models = [
      { name: "monkeycode-basic/glm", model: "monkeycode-basic/glm", source: SOURCE_MONKEYCODE, default: false },
    ];
    expect(modelDisplayByName(models, "monkeycode-basic/glm")).toEqual({ label: "glm", tier: "基础" });
    expect(modelDisplayByName(models, "已下线")).toEqual({ label: "已下线" });
  });
});

describe("buildModelMenu", () => {
  const models = [
    m("手工模型"),
    m("claude-x", SOURCE_BAIZHI, true),
    m("monkeycode-pro/deepseek-pro", SOURCE_MONKEYCODE),
  ];

  it("过滤额外匹配底层 model 串:remark 命名的会员条目能用 wire 名搜到", () => {
    const withRemark = [
      m("手工模型"),
      { ...m("深度求索", SOURCE_MONKEYCODE), model: "monkeycode-pro/deepseek-pro" },
    ];
    const hit = buildModelMenu(withRemark, [], "deepseek");
    expect(hit.groups.flatMap((g) => g.items.map((x) => x.name))).toEqual(["深度求索"]);
    expect(buildModelMenu(withRemark, [], "不存在").groups).toEqual([]);
  });

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
