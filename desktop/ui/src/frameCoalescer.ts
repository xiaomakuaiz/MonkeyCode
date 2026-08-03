// 下行帧的 UI 侧合流器。
//
// 壳侧已经按 30ms 批量发帧(driver/transport.rs 的 flusher),那一层保护的是
// IPC;这一层保护的是渲染线程,两者职责不同,不能互相替代:
//
//   * 30ms 定时与 vsync 不对齐 —— 一帧内可能落两批(白渲一次),也可能一帧不落;
//   * 壳不知道渲染要花多久。真正的背压只能在知道成本的这一侧做;
//   * 窗口不可见时 rAF 停摆,再按 30ms 往 React 里灌就是纯烧 CPU。
//
// 纯逻辑,时钟与调度全部注入,可在 node 下用假时钟测。
import { recordApply } from "./perf/perfProbe";

export interface FrameCoalescer<T> {
  /** 收到一批帧 */
  push(items: T[]): void;
  /** 立刻排空(连接关闭、会话切走等收尾时机) */
  flush(): void;
  dispose(): void;
  /** 仅供测试/探针:当前积压条数 */
  pending(): number;
}

export interface CoalescerOptions<T> {
  apply: (batch: T[]) => void;
  /** 必须立刻可见的帧(审批请求、AI 提问、轮次结束),不参与节流 */
  urgent?: (item: T) => boolean;
  /** 单拍渲染的时间预算;上一拍超了就多等一会儿,让下一拍合并更多帧 */
  budgetMs?: number;
  /** 节流上限:再慢也不能让内容停这么久 */
  maxDelayMs?: number;
  /** 积压超过这个条数就不再退让,下一帧立即排空(追赶) */
  catchUpThreshold?: number;
  /** 缓冲硬闸:窗口长期不可见时防止无限堆积 */
  maxBuffered?: number;
  now?: () => number;
  raf?: (cb: () => void) => number;
  cancelRaf?: (h: number) => void;
  setTimer?: (cb: () => void, ms: number) => number;
  clearTimer?: (h: number) => void;
  /** 窗口是否不可见(不可见时 rAF 不会触发,退化为定时器) */
  hidden?: () => boolean;
  /** 直通模式:不合流,push 即 apply。缺省在没有 rAF 的环境(node 测试)下自动开启 */
  passthrough?: boolean;
}

/** 没有 rAF 就没有"帧"可对齐(node 测试环境、SSR)。会话核心刻意不触浏览器
 * 全局,好让 vitest 直接驱动它 —— 合流本就是渲染侧的优化,拿不到调度器时
 * 直通即可,不能因此把核心变成浏览器专属。 */
const hasFrames = () => typeof requestAnimationFrame === "function";

export function createFrameCoalescer<T>(opts: CoalescerOptions<T>): FrameCoalescer<T> {
  const {
    apply,
    urgent,
    budgetMs = 4,
    maxDelayMs = 120,
    catchUpThreshold = 600,
    maxBuffered = 20000,
    now = () => (typeof performance === "undefined" ? 0 : performance.now()),
    raf = (cb) => requestAnimationFrame(cb),
    cancelRaf = (h) => cancelAnimationFrame(h),
    setTimer = (cb, ms) => setTimeout(cb, ms) as unknown as number,
    clearTimer = (h) => clearTimeout(h),
    hidden = () => typeof document !== "undefined" && document.hidden,
    passthrough = !opts.raf && !hasFrames(),
  } = opts;

  let buf: T[] = [];
  let rafH = 0;
  let timerH = 0;
  let lastCost = 0;
  let disposed = false;

  const clearScheduled = () => {
    if (rafH) cancelRaf(rafH);
    if (timerH) clearTimer(timerH);
    rafH = 0;
    timerH = 0;
  };

  function run() {
    rafH = 0;
    timerH = 0;
    if (disposed || buf.length === 0) return;
    const batch = buf;
    buf = [];
    const t0 = now();
    apply(batch);
    lastCost = now() - t0;
    recordApply(lastCost);
  }

  function schedule() {
    if (disposed || rafH || timerH) return;
    // 上一拍超预算就退让,让下一拍合并更多帧(批越大,单帧摊销越低);
    // 但积压太多时不再退让,否则内容会明显落后于引擎。
    const behind = buf.length >= catchUpThreshold;
    const delay = behind ? 0 : Math.min(maxDelayMs, Math.max(0, lastCost - budgetMs));
    if (hidden()) {
      // 不可见:rAF 不触发,用定时器低频排空,保持状态推进但不抢 CPU
      timerH = setTimer(run, 250);
      return;
    }
    if (delay > 0) timerH = setTimer(() => raf(run), delay);
    else rafH = raf(run);
  }

  return {
    push(items) {
      if (disposed || items.length === 0) return;
      if (passthrough) {
        apply(items);
        return;
      }
      for (const it of items) buf.push(it);
      if (buf.length > maxBuffered) buf.splice(0, buf.length - maxBuffered);
      if (urgent && items.some(urgent)) {
        clearScheduled();
        run();
        return;
      }
      schedule();
    },
    flush() {
      if (disposed) return;
      clearScheduled();
      run();
    },
    dispose() {
      disposed = true;
      clearScheduled();
      buf = [];
    },
    pending: () => buf.length,
  };
}
