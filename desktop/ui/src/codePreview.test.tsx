import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CodeView, DiffPanel } from "./components";

describe("code preview line numbers", () => {
  it("keeps CodeView line numbers out of DOM text", () => {
    const html = renderToStaticMarkup(<CodeView path="demo.ts" text={"const first = value;\nconst second = other;"} />);

    expect(html).toContain('class="mc-preview-line mc-code-line"');
    expect(html).toContain('data-line-number="1"');
    expect(html).toContain('data-line-number="2"');
    expect(html).not.toMatch(/>1<\/span>/);
    expect(html).not.toMatch(/>2<\/span>/);
  });

  it("keeps DiffPanel line numbers out of DOM text", () => {
    const html = renderToStaticMarkup(<DiffPanel text={"@@ -1 +1 @@\n-old value\n+new value"} />);

    expect(html).toContain('class="mc-preview-line mc-diff-line"');
    expect(html).toContain('data-line-number="1"');
    expect(html).not.toMatch(/>1<\/span>/);
  });
});
