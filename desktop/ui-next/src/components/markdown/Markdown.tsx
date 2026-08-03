// Markdown 渲染管线:marked(GFM)→ 自定义 renderer(代码高亮/复制按钮/
// 表格横滚包裹)→ DOMPurify 净化 → dangerouslySetInnerHTML。
// 行为契约:正文里的链接一律不走 webview 导航——http(s) 交系统浏览器
// (壳内 opener,浏览器模式新开标签),点击在容器上代理。
// 复制按钮用 daisyUI btn 类(注入 HTML 里的类是源码字面量,Tailwind 扫得到)。
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { useMemo, type MouseEvent } from "react";

import { t, useI18n } from "@/lib/i18n";
import { openExternal } from "@/lib/ipc/host";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function makeMarked(): Marked {
  const m = new Marked({ gfm: true, breaks: true, async: false });
  m.use({
    renderer: {
      code({ text, lang }) {
        const language = lang && hljs.getLanguage(lang) ? lang : null;
        const body = language ? hljs.highlight(text, { language }).value : escapeHtml(text);
        // data-md-copy 携带原文(escape 过),复制走它而不是回读高亮 DOM
        return (
          `<div class="md-code">` +
          `<button type="button" class="btn btn-xs absolute top-1.5 right-1.5 z-1 opacity-0" data-md-copy="${escapeHtml(text)}">${escapeHtml(t("md.copy"))}</button>` +
          `<pre><code class="hljs${language ? ` language-${language}` : ""}">${body}</code></pre>` +
          `</div>`
        );
      },
      table(token) {
        // 宽表格在容器内横滚,不撑破消息列
        const header = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join("");
        const rows = token.rows
          .map((row) => `<tr>${row.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`)
          .join("");
        return `<div class="md-scroll" tabindex="0"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
      },
    },
  });
  return m;
}

const parser = makeMarked();

export function renderMarkdown(source: string): string {
  const raw = parser.parse(source) as string;
  // target/rel 交给点击代理,净化时保守放行 data-*(复制按钮的原文载荷)
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}

function onContainerClick(e: MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  const copyBtn = target.closest<HTMLElement>("[data-md-copy]");
  if (copyBtn) {
    e.preventDefault();
    const text = copyBtn.getAttribute("data-md-copy") ?? "";
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    void clipboard.writeText(text).then(() => {
      const original = copyBtn.textContent;
      copyBtn.textContent = t("md.copied");
      window.setTimeout(() => {
        copyBtn.textContent = original;
      }, 1500);
    });
    return;
  }
  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (link) {
    // 契约:webview 不导航,交系统浏览器
    e.preventDefault();
    openExternal(link.getAttribute("href") ?? "");
  }
}

/** 块级 markdown(消息正文)。 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const { locale } = useI18n(); // 复制按钮文案随 locale 重渲
  const html = useMemo(() => renderMarkdown(source), [source, locale]);
  return (
    <div
      className={`md select-text ${className ?? ""}`}
      onClick={onContainerClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** 行内 markdown(摘要行/子代理 feed):只解析行内语法,保持单行布局。 */
export function MarkdownInline({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(parser.parseInline(source) as string, { USE_PROFILES: { html: true } }), [source]);
  return <span className={`mdi ${className ?? ""}`} onClick={onContainerClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
