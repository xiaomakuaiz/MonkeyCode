// 更新可用性 hook:挂载检查一次 + 窗口回焦静默复查(30 分钟闸门)。
// 安装成功后壳自行重启(promise 不返回,busy 不回收);失败复位忙态并
// 把错误文案交给视图外显——吞掉就是按钮永远转圈。
import { useEffect, useState } from "react";

import { takeUpdateCheck, updateCheck, updateInstall, type UpdateInfo } from "@/lib/ipc/update";

/** 兜底复查间隔:窗口一直开着、从没失去过焦点(挂着跑长任务正是如此)就
 *  永远等不到前台事件,只靠 focus 触发等于不查。被闸门挡掉只是顺延到下一
 *  次 tick,不会重复请求。 */
const FALLBACK_MS = 4 * 3600_000;

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
    // 三个触发点共用全局闸门(lib/ipc/update):挂载、窗口回焦、4 小时兜底。
    // 关于页的手动检查也记同一笔账,查完切个窗口回来不会再查一遍
    const check = () => {
      if (!takeUpdateCheck()) return;
      void updateCheck().then((info) => {
        if (alive && info?.available) setUpdate(info);
      });
    };
    check();
    window.addEventListener("focus", check);
    const timer = window.setInterval(check, FALLBACK_MS);
    return () => {
      alive = false;
      window.removeEventListener("focus", check);
      window.clearInterval(timer);
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
