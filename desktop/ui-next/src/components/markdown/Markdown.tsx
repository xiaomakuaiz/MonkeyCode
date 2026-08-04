// Markdown 渲染管线:marked(GFM)→ 自定义 renderer(代码高亮/复制按钮/
// 表格横滚包裹)→ DOMPurify 净化 → dangerouslySetInnerHTML。
// 行为契约:正文里的链接一律不走 webview 导航——http(s) 交系统浏览器
// (壳内 opener,浏览器模式新开标签),点击在容器上代理。
// 复制按钮用 daisyUI btn 类(注入 HTML 里的类是源码字面量,Tailwind 扫得到)。
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { useEffect, useMemo, useRef, type MouseEvent } from "react";

import { t, useI18n } from "@/lib/i18n";
import { openExternal } from "@/lib/ipc/host";
import { resolveMarkdownResource } from "@/lib/util/markdownPaths";

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

/** 本地资源标记属性:只能壳自己打,不能让正文内容自带。
 * DOMPurify 默认放行 `data-*`,而 marked 会原样透传正文里的裸 HTML——模型
 * 输出(或被渲染的文件内容)里写一个 `<img data-mc-local-src="...">`,就能
 * 指使 UI 去读它挑的路径。边界另有壳 upload_read 的工作区校验兜底,但
 * "标记属性"和"用户内容"共用一个命名空间本身是脆的:解析后、打标记前先
 * 清一遍,标记就重新只有本组件能打(净化在打标之后,顺序不能反——file:
 * 等地址会被净化器移除)。 */
const LOCAL_MARKS = ["data-mc-local-src", "data-mc-local-href"] as const;

export function renderMarkdown(source: string): string {
  const template = document.createElement("template");
  template.innerHTML = parser.parse(source) as string;
  for (const mark of LOCAL_MARKS) {
    for (const el of template.content.querySelectorAll(`[${mark}]`)) el.removeAttribute(mark);
  }
  for (const img of template.content.querySelectorAll<HTMLImageElement>("img[src]")) {
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    const res = resolveMarkdownResource(img.getAttribute("src") || "");
    if (res.kind === "local") {
      img.dataset.mcLocalSrc = res.path;
      img.removeAttribute("src");
    } else if (res.kind === "url") {
      img.setAttribute("src", res.src);
    }
  }
  for (const a of template.content.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const res = resolveMarkdownResource(a.getAttribute("href") || "");
    if (res.kind === "local") {
      a.dataset.mcLocalHref = res.path;
      a.setAttribute("href", "#");
    } else if (res.kind === "url") {
      a.setAttribute("href", res.src);
    }
  }
  // target/rel 交给点击代理,净化时保守放行 data-*(复制按钮原文载荷与本地标记)
  return DOMPurify.sanitize(template.innerHTML, { USE_PROFILES: { html: true } });
}

function onContainerClick(e: MouseEvent<HTMLElement>, onLocalLink?: (path: string) => void) {
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
    // 契约:webview 不导航——工作区文件走 reveal 回调,其余交系统浏览器
    e.preventDefault();
    const local = link.dataset.mcLocalHref;
    if (local) {
      onLocalLink?.(local);
      return;
    }
    openExternal(link.getAttribute("href") ?? "");
  }
}

/** 块级 markdown(消息正文)。localImageUrl/onLocalLink 缺省时行为与
 * 纯外链版完全一致(本地图不加载、本地链接点击无动作)。 */
export function Markdown({
  source,
  className,
  localImageUrl,
  onLocalLink,
}: {
  source: string;
  className?: string;
  /** 本地图片回读通道(工作区相对/绝对路径 → data URL)。 */
  localImageUrl?: (path: string) => Promise<string>;
  /** 本地链接点击代理(reveal 到文件管理器等)。 */
  onLocalLink?: (path: string) => void;
}) {
  const { locale } = useI18n(); // 复制按钮文案随 locale 重渲
  const html = useMemo(() => renderMarkdown(source), [source, locale]);
  const root = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<string, string>());
  // 本地图异步注入:流式重渲同一条消息时按路径缓存,不重复回读
  useEffect(() => {
    if (!localImageUrl || !root.current) return;
    let alive = true;
    for (const img of root.current.querySelectorAll<HTMLImageElement>("img[data-mc-local-src]")) {
      const path = img.dataset.mcLocalSrc;
      if (!path) continue;
      const cached = cache.current.get(path);
      if (cached) {
        img.src = cached;
        continue;
      }
      img.setAttribute("aria-busy", "true");
      localImageUrl(path).then(
        (url) => {
          if (!alive) return;
          cache.current.set(path, url);
          img.src = url;
          img.removeAttribute("aria-busy");
        },
        (err) => {
          if (!alive) return;
          img.removeAttribute("aria-busy");
          img.title = t("md.localImageFailed", { reason: err instanceof Error ? err.message : String(err) });
        },
      );
    }
    return () => {
      alive = false;
    };
    // localImageUrl 随父组件渲染生成新闭包;同一条消息只按 HTML 变化重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);
  return (
    <div
      ref={root}
      className={`md select-text ${className ?? ""}`}
      onClick={(e) => onContainerClick(e, onLocalLink)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** 行内 markdown(摘要行/子代理 feed):只解析行内语法,保持单行布局。 */
export function MarkdownInline({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(parser.parseInline(source) as string, { USE_PROFILES: { html: true } }), [source]);
  return <span className={`mdi ${className ?? ""}`} onClick={onContainerClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
