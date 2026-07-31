import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ModelMenuItem, ModelPicker } from "./chat";

describe("ModelMenuItem", () => {
  it("本地和云端共用整行 hover 与当前项勾选", () => {
    const html = renderToStaticMarkup(<ModelMenuItem label="测试模型" selected onClick={vi.fn()} />);

    expect(html).toContain('class="hv menu-item"');
    expect(html).toContain("width:100%");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("测试模型");
    // 长名截断后 hover 仍可读全名
    expect(html).toContain('title="测试模型"');
  });
});

describe("ModelPicker 关闭态(静态渲染,不触 localStorage)", () => {
  it("trigger 可收缩且 hover 显示当前模型全名,宽度上限收在包裹层", () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        models={[{ name: "一个非常非常非常长的模型名字", default: true }]}
        current="一个非常非常非常长的模型名字"
        onPick={vi.fn()}
      />,
    );

    // 包裹层限宽 + 允许收缩(长名不得把 composer 行的按钮挤出卡片)
    expect(html).toContain("max-width:220px");
    expect(html).toContain("min-width:0");
    expect(html).toContain("flex:0 1 auto");
    // trigger 不再自带 220 上限(由包裹层给),title 含全名
    expect(html).toContain("max-width:100%");
    expect(html).toContain("一个非常非常非常长的模型名字 · 点击切换(下一轮生效)");
  });
});
