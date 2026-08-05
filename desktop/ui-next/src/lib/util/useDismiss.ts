// 浮层(受控 dropdown)关闭胶水:pointerdown 落在容器外 → 关;Esc(window
// capture)→ 关并截断全局链(审批快捷键挂冒泡阶段且 esc 是不可逆拒绝,
// 浮层开着时这一下只能归浮层)。
// 为什么不用 onBlur + relatedTarget:壳内核 WebKitGTK 与 Safari 同源,点击
// 按钮不把焦点给按钮——focusout 的 relatedTarget 恒为 null,「焦点移出即
// 收起」在 mousedown 阶段就误关浮层,click 因内容卸载而丢失(思考菜单
// 弹不出、模型菜单点来源 tab 即消失的根因)。pointerdown 判定不依赖焦点
// 语义,各内核一致。
import { useEffect, type RefObject } from "react";

export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const box = ref.current;
      if (box && e.target instanceof Node && box.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
    // onClose 是稳定的 setState 包装(调用方保证),不追函数身份
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ref]);
}
