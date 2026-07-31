import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildModelMenu,
  groupMemberTiers,
  modelDisplay,
  modelDisplayByName,
  modelMenuTabs,
  readLastTaskModel,
  rememberLastTaskModel,
  shouldShowModelExtras,
  stripTierPrefix,
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

describe("上次开任务模型的存取", () => {
  it("缺省为空串,可往返,空名不覆盖", () => {
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

  it("组序固定:会员 → 百智云 → 自定义恒尾,与条目顺序无关", () => {
    const expected = ["MonkeyCode 会员", "百智云", "自定义"];
    expect(buildModelMenu(models, "").map((g) => g.label)).toEqual(expected);
    const shuffled = [models[0], models[1], models[2]].reverse();
    expect(buildModelMenu(shuffled, "").map((g) => g.label)).toEqual(expected);
  });

  it("过滤匹配 name 与来源组名(大小写不敏感),items 保原引用", () => {
    expect(buildModelMenu(models, "CLAUDE")).toEqual([{ label: "百智云", items: [models[1]] }]);
    // 组名命中 → 整组显示
    expect(buildModelMenu(models, "百智").map((g) => g.label)).toEqual(["百智云"]);
    expect(buildModelMenu(models, "monkeycode").map((g) => g.label)).toEqual(["MonkeyCode 会员"]);
    expect(buildModelMenu(models, "不存在")).toEqual([]);
  });

  it("过滤额外匹配底层 model 串:remark 命名的会员条目能用 wire 名搜到", () => {
    const withRemark = [
      m("手工模型"),
      { ...m("深度求索", SOURCE_MONKEYCODE), model: "monkeycode-pro/deepseek-pro" },
    ];
    expect(buildModelMenu(withRemark, "deepseek").flatMap((g) => g.items.map((x) => x.name))).toEqual([
      "深度求索",
    ]);
  });
});

describe("modelMenuTabs", () => {
  it("「全部」恒首,来源序同组序(会员→百智云→未知→自定义),会员缩写", () => {
    const tabs = modelMenuTabs([
      m("a"),
      m("b", "mystery"),
      m("c", SOURCE_BAIZHI),
      m("d", SOURCE_MONKEYCODE),
    ]);
    expect(tabs).toEqual([
      { key: "all", label: "全部" },
      { key: "monkeycode", label: "会员" },
      { key: "baizhi", label: "百智云" },
      { key: "mystery", label: "mystery" }, // 未知来源透传,不硬编码三来源
      { key: "", label: "自定义" },
    ]);
  });

  it("单来源只剩「全部+它」(渲染层按 length>=3 隐藏 tab 行)", () => {
    expect(modelMenuTabs([m("a"), m("b")])).toHaveLength(2);
  });
});

describe("groupMemberTiers", () => {
  const ultra = { ...m("旗舰甲", SOURCE_MONKEYCODE), model: "monkeycode-ultra/a" };
  const basic = { ...m("基础乙", SOURCE_MONKEYCODE), model: "monkeycode-basic/b" };
  const other = { ...m("公司内部模型", SOURCE_MONKEYCODE), model: "some-model" };

  it("按档位分桶保序、徽标随桶、无档位归「其他」、空桶剔除、items 保原引用", () => {
    const sections = groupMemberTiers([ultra, other, basic]);
    expect(sections.map((s) => s.label)).toEqual(["基础模型", "旗舰模型", "其他模型"]);
    expect(sections.map((s) => s.badge)).toEqual(["免费使用", "旗舰会员免费", undefined]);
    expect(sections[0].items[0]).toBe(basic);
    expect(sections[2].items[0]).toBe(other);
  });

  it("全是档位模型时没有「其他」节;孤「其他」节由渲染层省头", () => {
    expect(groupMemberTiers([ultra, basic]).map((s) => s.label)).toEqual(["基础模型", "旗舰模型"]);
    expect(groupMemberTiers([other]).map((s) => s.label)).toEqual(["其他模型"]);
  });
});

describe("shouldShowModelExtras", () => {
  it("超过 6 个模型才显示过滤框与来源 tab", () => {
    expect(shouldShowModelExtras(6)).toBe(false);
    expect(shouldShowModelExtras(7)).toBe(true);
  });
});
