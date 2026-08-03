// 表格渲染:实现已交给库自带的 TableNode(带横向滚动容器与列宽拖拽),
// 这里只守"宽表不会把内容轨撑破"这条产品约定 —— 表格必须落在滚动容器里,
// 且单元格数目与源文一致。具体样式不再断言,那是库和令牌的事。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./markdown";

describe("Markdown table", () => {
  it("宽表落在横向滚动容器里,单元格逐一渲染", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        text:
          "| 一 | 二 | 三 | 四 | 五 | 六 | 七 |\n| --- | --- | --- | --- | --- | --- | --- |\n" +
          "| 内容 | 内容 | 内容 | 内容 | 内容 | 内容 | 内容 |",
      }),
    );

    expect(html).toContain("table-node-wrapper");
    expect(html).toContain('data-node-type="table"');
    expect(html.match(/<th[ >]/g)).toHaveLength(7);
    expect(html.match(/<td[ >]/g)).toHaveLength(7);
  });
});
