import { marked } from "marked";
import { describe, expect, it } from "vitest";

import "./components";

describe("Markdown table", () => {
  it("为宽表格提供可聚焦的横向滚动容器", () => {
    const html = marked.parse("| 第一列 | 第二列 |\n| --- | --- |\n| 内容 | 内容 |", { async: false }) as string;

    expect(html).toContain('class="md-table-scroll"');
    expect(html).toContain('aria-label="可横向滚动的表格"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("<table>");
  });
});
