// 重内容路由:mermaid / d2 / 数学公式各有专属节点类型,不能退化成普通代码块
// 或普通段落。这条一旦回归,现象是"画个流程图结果显示成一段源码",很难一眼看出。
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./markdown";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("重内容节点路由", () => {
  it("mermaid 围栏走图表节点,不当普通代码块渲染", () => {
    const html = render("```mermaid\ngraph TD;\n A-->B;\n```");
    expect(html).not.toContain('data-language="mermaid"');
    expect(html).toMatch(/mermaid/i);
  });

  it("普通语言围栏仍是代码块", () => {
    const html = render("```ts\nconst a = 1;\n```");
    expect(html).toContain('data-node-type="code_block"');
    expect(html).toContain('data-language="ts"');
  });

  it("块级公式产出 math 节点,不当作普通段落", () => {
    const html = render("$$\na^2 + b^2 = c^2\n$$");
    expect(html).toContain('data-node-type="math_block"');
  });

  it("行内公式留在段落里,不撑成块级节点", () => {
    const html = render("勾股定理 $a^2+b^2=c^2$ 如上");
    expect(html).toContain("math-inline-wrapper");
    // 整段只有一个顶层节点(段落);公式若被当成块级会多切出一个 node-slot
    expect(html.match(/data-node-type=/g)).toHaveLength(1);
    expect(html).toContain('data-node-type="paragraph"');
  });
});
