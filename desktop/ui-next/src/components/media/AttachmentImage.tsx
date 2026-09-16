import { useEffect, useState } from "react";

import { useI18n } from "@/lib/i18n";

type Loader = (url: string) => Promise<string>;

/** URL 与读取作用域变化时立即隐藏旧图；过期异步结果不得覆盖新消息图片。 */
export function AttachmentImage({ url, load, alt, className, onClick }: {
  url: string;
  load: Loader;
  alt: string;
  className?: string;
  onClick?: () => void;
}) {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ url: string; load: Loader; attempt: number; src: string | null } | null>(null);
  const current = result?.url === url && result.load === load && result.attempt === attempt ? result : null;
  useEffect(() => {
    let alive = true;
    void load(url).then(
      (src) => alive && setResult({ url, load, attempt, src }),
      () => alive && setResult({ url, load, attempt, src: null }),
    );
    return () => { alive = false; };
  }, [url, load, attempt]);
  if (!current) return <span role="status" className="text-xs opacity-60">{t("chat.att.imageLoading")}</span>;
  if (!current.src) return (
    <button type="button" className="btn btn-ghost btn-xs" title={alt} onClick={() => setAttempt((n) => n + 1)}>
      {t("chat.att.imageFailed")}
    </button>
  );
  return <img src={current.src} alt={alt} title={alt} className={className} onClick={onClick}
    onError={() => setResult({ url, load, attempt, src: null })} />;
}
