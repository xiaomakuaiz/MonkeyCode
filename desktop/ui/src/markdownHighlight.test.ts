// 代码高亮分两条互不相干的链路,这个文件把两条都钉住:
//
// 1. 正文围栏 —— 已交给库自带的代码块(Monaco/Shiki),我们只守"围栏被识别成
//    code_block 节点且语言标记正确",不再断言高亮产物;
// 2. `highlightFence` —— 仍然是文件预览(codeView.tsx)与 diff 面板的高亮实现,
//    是纯函数,注入面必须继续守住。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { highlightFence } from "./codeView";
import { Markdown } from "./markdown";

const render = (text: string, streaming = false) =>
  renderToStaticMarkup(createElement(Markdown, { text, streaming }));

describe("正文围栏路由", () => {
  it("带语言标记的围栏识别为 code_block 并透出语言", () => {
    const html = render("```ts\nconst x: number = 1;\n```");
    expect(html).toContain('data-node-type="code_block"');
    expect(html).toContain('data-language="ts"');
    // 源码文本仍被转义,不产生可执行标记
    expect(html).not.toContain("<script");
  });

  it("未标语言的围栏仍是代码块,不退化成段落", () => {
    const html = render("```\nplain text\n```");
    expect(html).toContain('data-node-type="code_block"');
    expect(html).not.toContain('data-node-type="paragraph"');
  });

  it("流式未闭合的围栏标记为渲染中,收尾后转为完成态", () => {
    expect(render("```ts\nconst x = 1;", true)).toContain("is-rendering");
    expect(render("```ts\nconst x = 1;\n```")).not.toContain("is-rendering");
  });
});

describe("highlightFence(文件预览 / diff 面板)", () => {
  it("语言别名与附加参数:首段小写解析,c++/shell 这类映射到注册语言", () => {
    expect(highlightFence("echo hi", "shell")).toContain("hljs-built_in");
    expect(highlightFence("int a;", "c++")).not.toBeNull();
    expect(highlightFence("const a = 1", "js")).toContain("hljs-keyword");
  });

  it("未收录语言回落 null,由调用方走纯文本路径", () => {
    expect(highlightFence("+++", "brainfuck")).toBeNull();
    expect(highlightFence("plain", undefined)).toBeNull();
  });

  it("高亮输出除 span 外不引入任何标签(注入面不变)", () => {
    const out = highlightFence('const s = "<img src=x onerror=alert(1)>";', "ts") ?? "";
    const tags = out.match(/<[^>]+>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((t) => /^<\/?span[ >]/.test(t) || t === "</span>")).toBe(true);
    expect(out).toContain("&lt;img");
  });
});
