// 模型选择菜单的纯逻辑与偏好存取(与渲染解耦,便于单测):
// - mc.recentModels:最近选用的模型名(有序,最新在前,上限 3);
// - mc.lastTaskModel:上次开任务用的模型(新建页预选,配置默认让位)。
// 约束:模块顶层不碰 localStorage,且只用 getItem/setItem——静态渲染
// 测试(navigation.test/modelPicker.test)的存储 stub 只有这两个方法。
import { modelSourceLabel, type ModelInfo } from "./types";

const RECENT_MODELS_KEY = "mc.recentModels";
const LAST_TASK_MODEL_KEY = "mc.lastTaskModel";
const RECENT_MAX = 3;
/** 模型少时最近组/过滤框都是噪音(几乎复述整个菜单),超过该数才显示。 */
const MODEL_MENU_EXTRAS_THRESHOLD = 6;

export function shouldShowModelExtras(count: number): boolean {
  return count > MODEL_MENU_EXTRAS_THRESHOLD;
}

/** 读取最近选用的模型名(容错:坏 JSON/非数组/混入非字符串 → 剔除)。 */
export function readRecentModels(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_MODELS_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    const names: string[] = [];
    for (const item of value) {
      if (typeof item === "string" && item && !names.includes(item)) names.push(item);
    }
    return names.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** 记一次选用:去重置顶,上限 3;写失败静默(只丢一次"最近"记忆)。 */
export function touchRecentModel(name: string): void {
  if (!name) return;
  const next = [name, ...readRecentModels().filter((n) => n !== name)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next));
  } catch {
    // WebView 存储不可写时本次选择照常生效,不值得外显。
  }
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

export interface ModelMenuGroup {
  label: string;
  items: ModelInfo[];
}

/** 菜单内容构建:过滤(name + 来源组名,大小写不敏感)→ 按来源分桶
 * (「自定义」恒前,其余按首现顺序)+ 最近组。最近组在过滤时隐藏
 * (同一命中出现两次没有意义);与下方来源组刻意**不去重**——去重会让
 * 来源组内容随使用行为漂移,破坏组内的空间记忆。 */
export function buildModelMenu(
  models: ModelInfo[],
  recentNames: readonly string[],
  filter: string,
): { recent: ModelInfo[]; groups: ModelMenuGroup[] } {
  const q = filter.trim().toLowerCase();
  const shown = q
    ? models.filter(
        (m) => m.name.toLowerCase().includes(q) || modelSourceLabel(m.source).toLowerCase().includes(q),
      )
    : models;
  const groups: ModelMenuGroup[] = [];
  for (const m of shown) {
    const label = modelSourceLabel(m.source);
    let g = groups.find((x) => x.label === label);
    if (!g) {
      g = { label, items: [] };
      if (!m.source) groups.unshift(g);
      else groups.push(g);
    }
    g.items.push(m);
  }
  const recent = q
    ? []
    : recentNames
        .map((name) => models.find((m) => m.name === name))
        .filter((m): m is ModelInfo => !!m);
  return { recent, groups };
}
