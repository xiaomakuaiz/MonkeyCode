import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToolCard } from "./components";
import type { LogItem } from "./types";

const tool = (overrides: Partial<Extract<LogItem, { kind: "tool" }>> = {}): Extract<LogItem, { kind: "tool" }> => ({
  kind: "tool",
  tcId: "tool-1",
  title: "Read /repo/src/main.ts",
  rawInput: { file_path: "/repo/src/main.ts" },
  status: "ok",
  out: "不应展示的原始结果",
  durationMs: 1_200,
  ...overrides,
});

describe("ToolCard", () => {
  it("单行展示工具名称、调用目标和可靠耗时，不展示成功结果摘要", () => {
    const html = renderToStaticMarkup(<ToolCard item={tool()} workdir="/repo" />);

    expect(html).toContain("读取文件");
    expect(html).toContain("src/main.ts");
    expect(html).toContain("1.2s");
    expect(html).toContain("font-weight:500");
    expect(html).not.toContain("不应展示的原始结果");
  });

  it("失败结果在标题行下方保留为错误提示", () => {
    const html = renderToStaticMarkup(<ToolCard item={tool({ status: "fail", out: "permission denied", result: "permission denied\nstack" })} />);

    expect(html).toContain('role="alert"');
    expect(html).toContain("permission denied");
    expect(html).toContain("var(--err)");
  });
});
