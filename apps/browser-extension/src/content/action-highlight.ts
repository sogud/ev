/**
 * Action visualization overlay: a short-lived ring + action-name label shown
 * on the target element before EV acts on it. Rendered in an independent
 * fixed-position layer so the target element's style, layout, and hit
 * testing stay untouched.
 *
 * `drawActionHighlight` is the single source for the overlay rendering. It is
 * fully self-contained so it can run in the content script directly AND be
 * serialized via `toString()` into a CDP `Runtime.callFunctionOn` declaration.
 */

export const ACTION_HIGHLIGHT_STORAGE_KEY = 'actionHighlight';
export const ACTION_HIGHLIGHT_DURATION_MS = 900;
export const ACTION_HIGHLIGHT_ROOT_ID = '__ev_action_highlight__';

/**
 * Draw the highlight for one action on the target element. Safe to call for
 * consecutive actions: each call adds its own ring + label pair and removes
 * it after the display window.
 */
export function drawActionHighlight(element: Element, label: string): void {
  const durationMs = 900;
  const rootId = '__ev_action_highlight__';
  const maxPairs = 8;
  const rootStyle: Record<string, string> = {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    overflow: 'visible',
    'pointer-events': 'none',
    'z-index': '2147483647',
  };
  const ringStyle: Record<string, string> = {
    position: 'fixed',
    'box-sizing': 'border-box',
    border: '2px solid #2563eb',
    'border-radius': '4px',
    'box-shadow': '0 0 0 3px rgba(37, 99, 235, 0.25)',
    'pointer-events': 'none',
  };
  const labelStyle: Record<string, string> = {
    position: 'fixed',
    'box-sizing': 'border-box',
    background: '#2563eb',
    color: '#ffffff',
    font: '600 11px/1.6 system-ui, -apple-system, sans-serif',
    padding: '0 6px',
    'border-radius': '3px',
    'white-space': 'nowrap',
    'pointer-events': 'none',
  };
  const applyStyle = (target: HTMLElement, style: Record<string, string>): void => {
    for (const [property, value] of Object.entries(style)) {
      target.style.setProperty(property, value, 'important');
    }
  };

  const ownerDocument = element.ownerDocument ?? document;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  let root = ownerDocument.getElementById(rootId);
  if (!root) {
    root = ownerDocument.createElement('div');
    root.id = rootId;
    applyStyle(root, rootStyle);
    ownerDocument.documentElement.append(root);
  }
  while (root.childElementCount > maxPairs * 2 - 2) {
    root.firstElementChild?.remove();
  }

  const ring = ownerDocument.createElement('div');
  applyStyle(ring, ringStyle);
  ring.style.top = `${Math.max(rect.top - 2, 0)}px`;
  ring.style.left = `${Math.max(rect.left - 2, 0)}px`;
  ring.style.width = `${rect.width + 4}px`;
  ring.style.height = `${rect.height + 4}px`;

  const tag = ownerDocument.createElement('div');
  applyStyle(tag, labelStyle);
  tag.textContent = `EV · ${label}`;
  tag.style.left = `${Math.max(rect.left - 2, 0)}px`;
  tag.style.top = rect.top >= 22 ? `${rect.top - 20}px` : `${rect.top + rect.height + 4}px`;

  root.append(ring, tag);
  setTimeout(() => {
    ring.remove();
    tag.remove();
    if (root && root.childElementCount === 0) root.remove();
  }, durationMs);
}

/**
 * Function declaration for `Runtime.callFunctionOn` with `this` bound to the
 * target element and the label passed as the first argument; built from the
 * shared rendering source so the CDP path and content-script path never
 * diverge.
 */
export function cdpHighlightDeclaration(): string {
  return `function evActionHighlight(label) {
    (${drawActionHighlight.toString()})(this, label);
  }`;
}
