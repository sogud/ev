import { useEffect, useState, type RefObject } from 'react';

/**
 * Base UI Dialog 走 top layer，portal 到 body 的弹层 z-index 再高也被它盖住
 * （P1 回归根因：设置面板下拉「打不开」= 被 Dialog 遮挡）。
 * 触发器在 Dialog 内时，把弹层 portal 进 Dialog 自身，共享 top layer。
 */
export function useDialogPortalContainer(ref: RefObject<HTMLElement | null>): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(ref.current?.closest<HTMLElement>('.settings-modal') ?? null);
  }, [ref]);
  return container;
}
