// 更新可用性 hook:挂载检查一次 + 窗口回焦静默复查(30 分钟闸门)。
import { useEffect, useState } from "react";

import { shouldCheckUpdate, updateCheck, updateInstall, type UpdateInfo } from "@/lib/ipc/update";

export function useUpdate(): { update: UpdateInfo | null; installing: boolean; install: () => void } {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);

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
    install: () => {
      setInstalling(true);
      void updateInstall(); // 成功后壳自行重启;失败静默,下次焦点再报
    },
  };
}
