import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Markdown, renderMarkdown } from "./Markdown";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe("markdown 渲染", () => {
  it("标题/列表/行内代码正常产出(preflight 清零后靠 md.css 补齐,这里断结构)", () => {
    const { container } = render(<Markdown source={"# 标题\n\n- 甲\n- 乙\n\n`code`"} />);
    expect(container.querySelector("h1")?.textContent).toBe("标题");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("围栏代码带高亮与复制按钮;点复制写剪贴板并给反馈", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container } = render(<Markdown source={"```js\nconst a = 1;\n```"} />);
    expect(container.querySelector("code.hljs")).toBeTruthy();
    const btn = screen.getByRole("button", { name: "复制" });
    await userEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
    expect(btn.textContent).toBe("已复制");
  });

  it("链接不走 webview 导航:壳内交 opener", async () => {
    const calls: string[] = [];
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: {
        invoke: (cmd: string) => {
          calls.push(cmd);
          return Promise.resolve(null);
        },
      },
    };
    render(<Markdown source={"[官网](https://example.com)"} />);
    await userEvent.click(screen.getByRole("link", { name: "官网" }));
    expect(calls).toContain("plugin:opener|open_url");
  });

  it("净化:script 与事件属性被剥掉;表格包进横滚容器", () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)>\n\n|a|b|\n|-|-|\n|1|2|');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).toContain('class="md-scroll"');
  });
});
