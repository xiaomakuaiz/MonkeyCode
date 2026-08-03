// dom project 全局测试设置:视图测试固定中文 locale(断言以中文文案为锚,
// happy-dom 的 navigator.language 是 en-US,不钉住会整体漂到英文)。
import { beforeEach } from "vitest";

import { setLocale } from "@/lib/i18n";

beforeEach(() => {
  setLocale("zh-CN");
});
