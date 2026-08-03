// 单拍解析代价 vs 消息总长 —— 整个改造的核心命题。
//
// 旧实现每批帧 marked.parse 全文 + DOMPurify 全文,单拍 O(n)、整条 O(n²)。
// markstream 在 md 实例上留 source/token 缓存(streamParse:'auto'),声称增量解析。
// 组件内部持有的就是同一个 md 实例,所以直接驱动解析层即是对该命题的忠实检验。
//
// 计时只包住**最后一拍**:预热(把消息喂到 N KB)必须在计时区间之外,
// 否则量到的是"全量解析 + 一拍",必然随长度增长 —— 这正是第一版 bench 的错。
//
// 这个文件是度量工具,不是断言守卫(CI 里计时断言必然不稳)。
// 跑法:npx vitest run src/perf/parseCost.test.ts
import { describe, expect, it } from "vitest";
import { getMarkdown, parseMarkdownToStructure } from "stream-markdown-parser";
import { marked } from "marked";
import { highlightFence } from "../codeView";

const CHUNK = 400;

function makeAnswer(targetChars: number): string {
  const blocks = [
    "这一段是普通散文,用来撑出正文的主体篇幅,里面还夹着 **加粗** 与 `行内代码`。\n\n",
    "- 列表项一\n- 列表项二\n- 列表项三\n\n",
    "```ts\nexport function handle(input: string): number {\n  return input.length * 2;\n}\n```\n\n",
    "> 引用块,顺带测一下块级嵌套。\n\n",
  ];
  let out = "";
  for (let i = 0; out.length < targetChars; i++) out += blocks[i % blocks.length];
  return out.slice(0, targetChars);
}

/** 把消息按 chunk 逐拍喂进同一个 md 实例,返回每一拍的耗时(ms)。 */
function tickCosts(text: string): number[] {
  const md = getMarkdown();
  const costs: number[] = [];
  for (let end = CHUNK; end <= text.length; end += CHUNK) {
    const t0 = performance.now();
    parseMarkdownToStructure(text.slice(0, end), md, { final: false });
    costs.push(performance.now() - t0);
  }
  return costs;
}

/** 旧实现的单拍代价基线:每批帧 marked.parse 全文 + 每个围栏 hljs 全量高亮。
 * 注:node 下跑不了 DOMPurify,也复现不了 innerHTML 整块替换 —— 那两项是旧
 * 路径里更贵的部分,所以这个基线是**低估**,真实差距只会更大。 */
function markedTickCosts(text: string): number[] {
  marked.setOptions({ gfm: true, breaks: true });
  const costs: number[] = [];
  for (let end = CHUNK; end <= text.length; end += CHUNK) {
    const slice = text.slice(0, end);
    const t0 = performance.now();
    const tokens = marked.lexer(slice);
    for (const t of tokens) if (t.type === "code") highlightFence(t.text, (t as { lang?: string }).lang);
    marked.parser(tokens);
    costs.push(performance.now() - t0);
  }
  return costs;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

describe("单拍解析代价随消息总长的变化", () => {
  it("量出曲线", () => {
    const rows: string[] = [];
    const tailByKb: Record<number, number> = {};
    const speedupByKb: Record<number, number> = {};
    for (const kb of [5, 10, 20, 40, 80]) {
      const text = makeAnswer(kb * 1024);
      // 跑三轮取每档的中位数,压掉 GC 抖动
      const runs = [tickCosts(text), tickCosts(text), tickCosts(text)];
      const ticks = runs[0].length;
      // 最后 10 拍 = 消息已经很长时的单拍代价,用户在长回答末尾感受到的就是它
      const tail = median(runs.flatMap((r) => r.slice(-10)));
      const oldRuns = [markedTickCosts(text), markedTickCosts(text)];
      const oldTail = median(oldRuns.flatMap((r) => r.slice(-10)));
      const oldTotal = median(oldRuns.map((r) => r.reduce((a, b) => a + b, 0)));
      const all = median(runs.flat());
      const total = median(runs.map((r) => r.reduce((a, b) => a + b, 0)));
      tailByKb[kb] = tail;
      speedupByKb[kb] = oldTail / tail;
      rows.push(
        `${String(kb).padStart(3)}KB  拍数 ${String(ticks).padStart(3)}  ` +
          `末段单拍 ${tail.toFixed(2)}ms(旧 ${oldTail.toFixed(2)}ms, ${(oldTail / tail).toFixed(1)}x)  ` +
          `整条合计 ${total.toFixed(0)}ms(旧 ${oldTotal.toFixed(0)}ms, ${(oldTotal / total).toFixed(1)}x)  ` +
          `单拍中位 ${all.toFixed(2)}ms`,
      );
    }
    const table = "\n" + rows.join("\n") + "\n";
    // 验收口径(tasks/todo.md §三):40KB 回答末段的单拍代价必须留在帧预算内。
    // 注意这只是**解析层**;React 协调、DOM、Monaco 挂载要靠 ?perf=1 的真机探针。
    expect(tailByKb[40], `末段单拍超预算${table}`).toBeLessThan(8);
    // 相对旧实现(marked 全文解析 + 全量高亮)必须有量级上的改善。
    // 旧基线在 node 下还测不到 DOMPurify 与 innerHTML 整块替换,是低估值。
    expect(speedupByKb[40], `相对旧实现的改善不足${table}`).toBeGreaterThan(2);
    // 形状守卫:16 倍长度下单拍不该也涨 16 倍(真·常数≈1x,线性≈16x)。
    // 实测约 7x —— 见文档:增量解析压掉了词法分析,但每拍仍要重建整篇 AST。
    expect(tailByKb[80] / tailByKb[5], `单拍代价随长度增长过快${table}`).toBeLessThan(12);
  }, 120_000); // 量测本身要跑几秒,默认 5s 超时不够
});
