// 模型选择菜单的纯逻辑与偏好存取(与渲染解耦,便于单测):
// - mc.lastTaskModel:上次开任务用的模型(新建页预选,配置默认让位)。
// 约束:模块顶层不碰 localStorage,且只用 getItem/setItem——静态渲染
// 测试(navigation.test/modelPicker.test)的存储 stub 只有这两个方法。
//(旧的 mc.recentModels「最近使用」已整体移除;残留的存储键无害不清理。)
import { builtinTierLabel } from "./cloud";
import { modelSourceLabel, SOURCE_BAIZHI, SOURCE_MONKEYCODE, type ModelInfo } from "./types";

const LAST_TASK_MODEL_KEY = "mc.lastTaskModel";
/** 模型少时过滤框/来源 tab 都是噪音(几乎复述整个菜单),超过该数才显示。 */
const MODEL_MENU_EXTRAS_THRESHOLD = 6;

export function shouldShowModelExtras(count: number): boolean {
  return count > MODEL_MENU_EXTRAS_THRESHOLD;
}

/** 上次开任务用的模型(""=没记过)。是否仍可用由调用方对着当下的模型
 * 列表校验——models 是异步到达的 props,校验必须放在派生处而不是这里。 */
export function readLastTaskModel(): string {
  try {
    return localStorage.getItem(LAST_TASK_MODEL_KEY) || "";
  } catch {
    return "";
  }
}

export function rememberLastTaskModel(name: string): void {
  if (!name) return;
  try {
    localStorage.setItem(LAST_TASK_MODEL_KEY, name);
  } catch {
    // 同上,静默。
  }
}

/** 剥会员档位前缀(monkeycode-xxx/)得短名,剥空回落原名。Web
 * stripBuiltinPublicModelPackagePrefix 同款正则;remark 里写了前缀也一并剥。 */
export function stripTierPrefix(name: string): string {
  return name.replace(/^monkeycode-[^/]+\//i, "") || name;
}

/** 模型条目的展示投影:短名 + 档位(基础/专业/旗舰)。**纯展示层**——
 * name 是引擎键/lastTaskModel 记忆键,onPick 仍必须用原始 name。
 * 只对会员来源生效(手工条目取名 monkeycode-pro-x 不该被误打会员档);
 * 档位与 Web 口径一致从底层 model 串判(name 可能是 remark 别名)。 */
export function modelDisplay(m: Pick<ModelInfo, "name" | "model" | "source">): {
  label: string;
  tier?: string;
} {
  if (m.source !== SOURCE_MONKEYCODE) return { label: m.name };
  return { label: stripTierPrefix(m.name), tier: builtinTierLabel(m.model) };
}

/** 触发器用:按 name 回查条目做展示投影;查不到(下线模型兜底项)原样。 */
export function modelDisplayByName(models: readonly ModelInfo[], name: string): {
  label: string;
  tier?: string;
} {
  const m = models.find((x) => x.name === name);
  return m ? modelDisplay(m) : { label: name };
}

export interface ModelMenuGroup {
  label: string;
  items: ModelInfo[];
}

/** 来源固定优先级(组序与 tab 序共用,单一出处避免两者打架):
 * 会员 → 百智云 → 未知来源(彼此按首现)→ 自定义恒尾。 */
const sourceRank = (source?: string): number =>
  source === SOURCE_MONKEYCODE ? 0 : source === SOURCE_BAIZHI ? 1 : source ? 2 : 3;

/** 菜单内容构建:过滤(name + 底层 model 串 + 来源组名,大小写不敏感;
 * 按 model 匹配让 remark 命名的会员条目也能用 wire 名搜到,命中词可能
 * 不在显示名里——有意取舍)→ 按来源分桶,组序走 sourceRank(稳定排序,
 * 未知来源之间保持首现顺序)。 */
export function buildModelMenu(models: ModelInfo[], filter: string): ModelMenuGroup[] {
  const q = filter.trim().toLowerCase();
  const shown = q
    ? models.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          (m.model || "").toLowerCase().includes(q) ||
          modelSourceLabel(m.source).toLowerCase().includes(q),
      )
    : models;
  const groups: (ModelMenuGroup & { rank: number })[] = [];
  for (const m of shown) {
    const label = modelSourceLabel(m.source);
    let g = groups.find((x) => x.label === label);
    if (!g) {
      g = { label, items: [], rank: sourceRank(m.source) };
      groups.push(g);
    }
    g.items.push(m);
  }
  groups.sort((a, b) => a.rank - b.rank);
  return groups.map(({ label, items }) => ({ label, items }));
}

export interface ModelMenuTab {
  key: string;
  label: string;
}

/** 来源 tab:「全部」+ 出现过的来源(序同组序;会员缩写为「会员」,
 * 未知来源沿用 modelSourceLabel 的透传)。key 用 source 原值(自定义 "")。 */
export function modelMenuTabs(models: ModelInfo[]): ModelMenuTab[] {
  const tabs: (ModelMenuTab & { rank: number })[] = [];
  for (const m of models) {
    const key = m.source || "";
    if (tabs.some((t) => t.key === key)) continue;
    const label = m.source === SOURCE_MONKEYCODE ? "会员" : modelSourceLabel(m.source);
    tabs.push({ key, label, rank: sourceRank(m.source) });
  }
  tabs.sort((a, b) => a.rank - b.rank);
  return [{ key: "all", label: "全部" }, ...tabs.map(({ key, label }) => ({ key, label }))];
}

export interface MemberTierSection {
  label: string;
  badge?: string;
  items: ModelInfo[];
}

/** 会员 tab 内的档位小节(徽标词与 groupCloudModels 一致——资格说明,
 * 本地条目同步时已按会员档过滤过);无档位的服务端自定义模型归「其他」。 */
const MEMBER_TIER_SECTIONS: { tier?: string; label: string; badge?: string }[] = [
  { tier: "基础", label: "基础模型", badge: "免费使用" },
  { tier: "专业", label: "专业模型", badge: "专业会员免费" },
  { tier: "旗舰", label: "旗舰模型", badge: "旗舰会员免费" },
  { tier: undefined, label: "其他模型" },
];

export function groupMemberTiers(items: ModelInfo[]): MemberTierSection[] {
  return MEMBER_TIER_SECTIONS.map((s) => ({
    label: s.label,
    badge: s.badge,
    items: items.filter((m) => builtinTierLabel(m.model) === s.tier),
  })).filter((s) => s.items.length > 0);
}
