/** 复制到剪贴板:异步 API 不可用/被拒时回退 execCommand(Win7 WebView2 无 clipboard API)。
 * 单独成模块是为了断开 markdown 渲染层与 contextMenu 之间的循环依赖。 */
export function copyText(text: string) {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(fallback);
  } else {
    fallback();
  }
}
