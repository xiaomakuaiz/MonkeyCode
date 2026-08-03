// 更新可用性 hook:挂载检查一次 + 窗口回焦静默复查(30 分钟闸门)。
// 安装成功后壳自行重启(promise 不返回,busy 不回收);失败复位忙态并
// 把错误文案交给视图外显——吞掉就是按钮永远转圈。
import { useEffect, useState } from "react";

import { shouldCheckUpdate, updateCheck, updateInstall, type UpdateInfo } from "@/lib/ipc/update";

export function useUpdate(): {
  update: UpdateInfo | null;
  installing: boolean;
  /** 上次安装失败的原因;null = 没失败过/重试中 */
  error: string | null;
  install: () => void;
} {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let lastAt: number | null = null;
    const check = () => {
      lastAt = Date.now();
      void updateCheck().then((info) => {
        if (alive && info?.available) setUpdate(info);
      });
    };
    check();
    const onFocus = () => {
      if (shouldCheckUpdate(Date.now(), lastAt)) check();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return {
    update,
    installing,
    error,
    install: () => {
      setInstalling(true);
      setError(null);
      void updateInstall().catch((e) => {
        // 失败:复位忙态并外显;成功后壳自行重启,不会走到这里
        setInstalling(false);
        setError(e instanceof Error ? e.message : String(e));
      });
    },
  };
}
