// 合流器:假时钟下钉住合并、背压退让、追赶、终态帧插队、不可见退化。
import { describe, expect, it } from "vitest";
import { createFrameCoalescer } from "./frameCoalescer";

/** 极简调度器替身:手动推进 rAF 与定时器,时间由测试自己控制。 */
function harness(applyCost = 0, hiddenFlag = { v: false }) {
  let t = 0;
  const rafs: Array<() => void> = [];
  const timers: Array<{ at: number; cb: () => void; id: number }> = [];
  let id = 1;
  const applied: number[][] = [];
  const c = createFrameCoalescer<number>({
    apply: (b) => {
      applied.push(b);
      t += applyCost;
    },
    urgent: (n) => n < 0,
    now: () => t,
    raf: (cb) => {
      rafs.push(cb);
      return id++;
    },
    cancelRaf: () => {},
    setTimer: (cb, ms) => {
      const h = id++;
      timers.push({ at: t + ms, cb, id: h });
      return h;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    hidden: () => hiddenFlag.v,
  });
  return {
    c,
    applied,
    tick() {
      const due = rafs.splice(0, rafs.length);
      due.forEach((f) => f());
    },
    advance(ms: number) {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      due.forEach((x) => timers.splice(timers.indexOf(x), 1));
      due.forEach((x) => x.cb());
    },
    timerCount: () => timers.length,
  };
}

describe("帧合流器", () => {
  it("一帧内的多批帧合并成一次 apply", () => {
    const h = harness();
    h.c.push([1, 2]);
    h.c.push([3]);
    h.c.push([4]);
    expect(h.applied).toHaveLength(0); // 还没到 rAF
    h.tick();
    expect(h.applied).toEqual([[1, 2, 3, 4]]);
  });

  it("上一拍超预算就退让,让下一拍合并更多帧", () => {
    const h = harness(20); // 每次 apply 花 20ms,预算 4ms
    h.c.push([1]);
    h.tick(); // 第一拍照常
    expect(h.applied).toHaveLength(1);
    h.c.push([2]);
    h.tick(); // 退让期内不该有 rAF 排空
    expect(h.applied).toHaveLength(1);
    h.advance(16); // 退让 20-4=16ms 后才排 rAF
    h.tick();
    expect(h.applied).toEqual([[1], [2]]);
  });

  it("积压超阈值时不再退让,立刻追赶", () => {
    const h = harness(50);
    h.c.push([1]);
    h.tick();
    h.c.push(Array.from({ length: 700 }, (_, i) => i + 2));
    h.tick(); // 追赶:直接走 rAF,不等退让
    expect(h.applied).toHaveLength(2);
    expect(h.applied[1]).toHaveLength(700);
  });

  it("终态帧插队,不等节流", () => {
    const h = harness(50);
    h.c.push([1]);
    h.tick();
    h.c.push([2]);
    expect(h.applied).toHaveLength(1); // 退让中
    h.c.push([-1]); // 负数 = urgent
    expect(h.applied).toHaveLength(2);
    expect(h.applied[1]).toEqual([2, -1]); // 积压的一并带出,不乱序
  });

  it("窗口不可见时退化为定时器,不依赖 rAF", () => {
    const hidden = { v: true };
    const h = harness(0, hidden);
    h.c.push([1]);
    h.tick(); // rAF 不该被用到
    expect(h.applied).toHaveLength(0);
    h.advance(250);
    expect(h.applied).toEqual([[1]]);
  });

  it("dispose 后不再 apply", () => {
    const h = harness();
    h.c.push([1]);
    h.c.dispose();
    h.tick();
    expect(h.applied).toHaveLength(0);
  });
});
