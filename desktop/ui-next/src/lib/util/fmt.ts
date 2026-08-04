/** 千位缩写(旧 UI fmtK 同款):1234→1.2k、2345678→2.3M;运行条 tokens 摘要用。 */
export const fmtK = (n: number): string =>
  n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
