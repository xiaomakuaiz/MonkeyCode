// Markdown 渲染。
//
// 块级正文走 markstream-react:它把 markdown 解析成 AST 再渲成 React 组件,
// 流式期间只有变化的节点重渲 —— 这正是旧实现(每批帧 marked.parse 全文 +
// DOMPurify 全文 + innerHTML 整块替换,单拍 O(n)、整条 O(n²))卡顿的根因。
// 未闭合围栏/公式由解析器发 loading 中间态,不再"先露原始星号再突然变粗体"。
//
// 行内单行仍走 marked:markstream 没有内联单行渲染模式,而子代理 feed 行与
// 思考摘要要求"不产生块级元素、保持单行 ellipsis 布局"。行内只涉及加粗/
// 行内代码/链接,两个解析器在这个子集上的差异可以忽略。
import DOMPurify from "dompurify";
import { marked } from "marked";
import MarkdownRender, { setCustomComponents } from "markstream-react";
import { useMemo, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { openExternal } from "./host";
import { McImage, MdHostContext, type MdHost } from "./mdNodes";
import { resolveMarkdownResource } from "./markdownPaths";
import { useIsDark } from "./theme";

marked.setOptions({ gfm: true, breaks: true });

// 只覆盖图片一个节点:其余(代码块 / 表格 / 链接 / 公式 / 图表)全部用库自带实现。
// 图片非覆盖不可 —— 见 mdNodes.tsx 顶部说明,这是库文档给桌面端指定的接入点。
export const MD_SCOPE = "mc";
setCustomComponents(MD_SCOPE, { image: McImage as never });

/** 链接一律不走 webview 导航:WKWebView 里点 `<a>` 会把整个应用页面跳走。
 *
 * 用一道容器级事件代理而不是自定义 LinkNode:markdown 链接和正文里的**裸 HTML**
 * `<a>` 走的是库里两条不同路径(link 节点 / html_inline),自定义组件只能盖住前者;
 * 代理一次两条都覆盖,自己要维护的代码也更少。 */
function useAnchorGuard(onLocalLink?: (path: string) => void) {
  return (e: ReactMouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const source = resolveMarkdownResource(a.getAttribute("href") || "");
    if (source.kind === "local") onLocalLink?.(source.path);
    else if (source.kind === "url" && /^https?:/i.test(source.src)) openExternal(source.src);
  };
}

/** agent 正文按 Markdown 渲染;流式期间只重渲变化的节点。 */
export function Markdown({
  text,
  localImageUrl,
  onLocalLink,
  streaming,
}: {
  text: string;
  localImageUrl?: (path: string) => Promise<string>;
  onLocalLink?: (path: string) => void;
  /** 本条仍在流式聚合中(false = 已收尾,解析器可以关掉 loading 中间态) */
  streaming?: boolean;
}) {
  const host = useMemo<MdHost>(() => ({ localImageUrl, onLocalLink }), [localImageUrl, onLocalLink]);
  const isDark = useIsDark();
  const onAnchorClick = useAnchorGuard(onLocalLink);
  return (
    <div className="md" onClick={onAnchorClick}>
      <MdHostContext.Provider value={host}>
        <MarkdownRender
          customId={MD_SCOPE}
          content={text}
          final={!streaming}
          // 模型输出是不可信内容:safe 策略拦下 script/iframe/form/embed、on* 事件属性、
          // javascript:/vbscript:/data:text/html 与协议相对 URL。
          htmlPolicy="safe"
          // Mermaid / D2 / KaTeX 在 JS 里生成 SVG,配色拿不到 CSS 变量,只能喂值。
          isDark={isDark}
          // 会话流自己是一个滚动容器,库内虚拟化会和壳的锚点恢复/大纲跳转打架;
          // 关掉它、改用批量挂载(库文档给的 chat 预设同款)。
          maxLiveNodes={0}
          batchRendering
          renderBatchSize={16}
          renderBatchDelay={8}
          renderBatchBudgetMs={4}
          // 重节点靠近视口才实渲,不阻塞正文流。
          viewportPriority
          deferNodesUntilVisible
          // 入场淡入必须关:流式每提交一个节点就重放一次 opacity 动画会闪成一片
          // (库文档明确警告过 fade + smoothStreaming 的这个组合)。
          fade={false}
          showTooltips={false}
          smoothStreamingOptions={{ flushOnFinish: true }}
        />
      </MdHostContext.Provider>
    </div>
  );
}

/** 单行内联 markdown(子代理 feed 行:加粗/行内代码等,不产生块级元素,
 * 保持单行 ellipsis 布局)。 */
export function MarkdownInline({ text, style }: { text: string; style?: CSSProperties }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parseInline(text, { async: false }) as string), [text]);
  return <span className="ellipsis mdi" style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}
