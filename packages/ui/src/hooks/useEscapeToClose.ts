import { useEffect, useRef } from 'react';

const escapeStack: symbol[] = [];

/**
 * Shared Escape-to-close for non-modal surfaces (InspectorPanel, FleetDrawer).
 * Modals and popovers get first refusal; among inline surfaces, only the most
 * recently mounted one closes.
 */
export function useEscapeToClose(onClose: () => void): void {
  const id = useRef(Symbol('escape-surface')).current;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    escapeStack.push(id);
    const handler = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        escapeStack[escapeStack.length - 1] !== id
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      const index = escapeStack.lastIndexOf(id);
      if (index >= 0) escapeStack.splice(index, 1);
    };
  }, [id]);
}
