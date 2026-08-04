import { describe, expect, it } from "vitest";

import { fmtK } from "./fmt";

describe("fmtK 千位缩写", () => {
  it("三档:原样 / k / M,一位小数四舍五入", () => {
    expect(fmtK(0)).toBe("0");
    expect(fmtK(999)).toBe("999");
    expect(fmtK(1234)).toBe("1.2k");
    expect(fmtK(45_678)).toBe("45.7k");
    expect(fmtK(2_345_678)).toBe("2.3M");
  });

  it("整值不带小数尾巴", () => {
    expect(fmtK(2000)).toBe("2k");
    expect(fmtK(1_000_000)).toBe("1M");
  });
});
