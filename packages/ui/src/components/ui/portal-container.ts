import { useEffect, useState, type RefObject } from 'react';

/**
 * Base UI dialogs live in the top layer; popups portaled to body are covered no
 * matter their z-index (P1 regression root cause: settings dropdowns "not opening").
 * When the trigger sits inside a dialog, portal the popup into the dialog itself so
 * both share the top layer.
 */
export function useDialogPortalContainer(ref: RefObject<HTMLElement | null>): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(ref.current?.closest<HTMLElement>('.settings-modal') ?? null);
  }, [ref]);
  return container;
}
