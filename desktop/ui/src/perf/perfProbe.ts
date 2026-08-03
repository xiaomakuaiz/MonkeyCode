// 渲染性能探针(仅在 ?perf=1 时启用,默认全程零开销)。
//
// node 侧的 parseCost.test.ts 只能量解析层;真正的一拍还包含 React 协调、
// DOM 变更、Monaco 挂载与滚动引发的强制回流 —— 那些只有在真机上才量得到。
// 指标口径照 markstream 1.0 benchmark:max long task、p95 rAF 间隔、
// 每拍提交耗时、滚动位置漂移。
//
// 用法:给应用 URL 加 ?perf=1,流式跑一轮,然后在 devtools 里:
//   __mcPerf.report()   // 打印汇总
//   __mcPerf.reset()    // 归零后再测一段
interface Probe {
  applyMs: number[];
  rafGaps: number[];
  longTasks: number[];
  scrollDrift: number[];
}

let probe: Probe | null = null;

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
};
const fmt = (xs: number[], unit = "ms") =>
  xs.length
    ? `n=${xs.length} p50=${pct(xs, 50).toFixed(1)}${unit} p95=${pct(xs, 95).toFixed(1)}${unit} max=${Math.max(...xs).toFixed(1)}${unit}`
    : "(无样本)";

/** 一拍帧应用的耗时。非探针模式下是空调用,不影响生产路径。 */
export function recordApply(ms: number): void {
  probe?.applyMs.push(ms);
}

/** 贴底跟随后,内容底沿与视口底沿的偏差 —— 跟丢了这里就不是 0。 */
export function recordScrollDrift(px: number): void {
  probe?.scrollDrift.push(Math.abs(px));
}

export function startPerfProbe(): void {
  if (probe || typeof window === "undefined") return;
  if (!new URLSearchParams(location.search).has("perf")) return;
  probe = { applyMs: [], rafGaps: [], longTasks: [], scrollDrift: [] };

  // 长任务:超过 50ms 的主线程占用 = 用户能看见的卡顿
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) probe?.longTasks.push(e.duration);
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* WKWebView 不支持 longtask,其余指标照常 */
  }

  // rAF 间隔:比"提交耗时"更贴近用户感知 —— 掉帧就体现在这里
  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    probe?.rafGaps.push(now - last);
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const w = window as unknown as { __mcPerf: unknown };
  w.__mcPerf = {
    report() {
      if (!probe) return;
      const over50 = probe.longTasks.filter((d) => d > 50);
      /* eslint-disable no-console */
      console.log("每拍提交耗时  ", fmt(probe.applyMs));
      console.log("rAF 间隔      ", fmt(probe.rafGaps));
      console.log("长任务(>50ms)", over50.length ? fmt(over50) : "0 次 ✅");
      console.log("滚动漂移      ", fmt(probe.scrollDrift, "px"));
      /* eslint-enable no-console */
    },
    reset() {
      if (probe) probe = { applyMs: [], rafGaps: [], longTasks: [], scrollDrift: [] };
    },
    raw: () => probe,
  };
}
