// markstream-react 的自定义节点渲染器 —— 只保留**库无法代劳**的那一个。
//
// 代码块 / 表格 / 链接一律用库自带实现(含它的 index.css),不再自绘。
// 图片必须留自定义:markdown 里的图片地址是浏览器 URL,而模型写出来的往往是
// 工作区文件路径;库的默认 ImageNode 会把 `/abs/path.png` 当站点绝对 URL 请求,
// `file://` 更是被它的图片策略直接拦掉。库文档自己给的桌面端方案就是
// "用应用可控的通道暴露文件 + 自定义 ImageNode 改写 src"
// (guide/image-node#local-file-images-in-desktop-apps),这里正是那个改写点。
import { createContext, useContext, useEffect, useState } from "react";
import { resolveMarkdownResource } from "./markdownPaths";

/** 宿主能力经 context 下发:setCustomComponents 是全局注册,拿不到渲染点的 props。 */
export interface MdHost {
  /** 工作区路径 → 可渲染 URL(壳 IPC 回读;不传则本地图片不加载) */
  localImageUrl?: (path: string) => Promise<string>;
  /** 正文里的工作区文件链接的安全打开动作 */
  onLocalLink?: (path: string) => void;
}

export const MdHostContext = createContext<MdHost>({});

/** 本地图片走壳 IPC 回读(uploads.rs 里另有工作区校验兜底),远端图片直出。
 * 裸路径不进 src —— 那等于让模型指使 UI 去读它挑的文件。 */
export function McImage({ node }: { node: { src?: string; alt?: string; title?: string | null } }) {
  const { localImageUrl } = useContext(MdHostContext);
  const source = resolveMarkdownResource(node.src ?? "");
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  const path = source.kind === "local" ? source.path : "";
  useEffect(() => {
    if (!path || !localImageUrl) return;
    let alive = true;
    localImageUrl(path).then(
      (url) => alive && setResolved(url),
      (e) => alive && setFailed(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [path, localImageUrl]);
  if (source.kind === "empty") return null;
  const src = source.kind === "url" ? source.src : resolved;
  if (!src) {
    return (
      <span
        aria-busy={!failed}
        data-mc-local-error={failed ? "true" : undefined}
        title={failed ? `本地图片加载失败: ${failed}` : undefined}
      />
    );
  }
  return (
    <img
      src={src}
      alt={node.alt ?? ""}
      title={node.title ?? node.alt ?? ""}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}
