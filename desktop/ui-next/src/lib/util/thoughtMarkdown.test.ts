import { describe, expect, it } from "vitest";

import { thoughtMarkdown } from "./thoughtMarkdown";

describe("thoughtMarkdown(流式 **** 连拼修复)", () => {
  it("相邻加粗标题的 **** 拆成段落边界", () => {
    expect(thoughtMarkdown("**先看日志****再改代码**")).toBe("**先看日志**\n\n**再改代码**");
  });

  it("多处连拼逐一拆开", () => {
    expect(thoughtMarkdown("**A****B****C**")).toBe("**A**\n\n**B**\n\n**C**");
  });

  it("无连拼原样返回(正常加粗不受影响)", () => {
    expect(thoughtMarkdown("普通 **加粗** 文本")).toBe("普通 **加粗** 文本");
    expect(thoughtMarkdown("")).toBe("");
  });
});
