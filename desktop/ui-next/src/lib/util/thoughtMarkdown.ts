/** 引擎思考流按 chunk 裸拼,相邻加粗标题会连成 `**A****B**`;markdown
 * 解析会把中间的 `****` 当字面量吞进同一个 strong,先补成段落边界再交给
 * 渲染层。(移植旧 UI logView.tsx 的同名修复。) */
export function thoughtMarkdown(text: string): string {
  return text.replace(/\*{4}/g, "**\n\n**");
}
