import { marked } from "marked";
import { describe, expect, it } from "vitest";

import "./components";

describe("Markdown table", () => {
  it("按列数限制总宽度并提供可聚焦的横向滚动容器", () => {
    const html = marked.parse(
      "| 一 | 二 | 三 | 四 | 五 | 六 | 七 |\n| --- | --- | --- | --- | --- | --- | --- |\n| 内容 | 内容 | 内容 | 内容 | 内容 | 内容 | 内容 |",
      { async: false },
    ) as string;

    expect(html).toContain('class="md-table-scroll"');
    expect(html).toContain('aria-label="可横向滚动的表格"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('--md-table-min-width:840px');
    expect(html).toContain('--md-table-max-width:2240px');
    expect(html).toContain("<table>");
  });
});
