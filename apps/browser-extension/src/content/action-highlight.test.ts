import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACTION_HIGHLIGHT_DURATION_MS,
  ACTION_HIGHLIGHT_ROOT_ID,
  cdpHighlightDeclaration,
  drawActionHighlight,
} from './action-highlight';

/** Minimal DOM stand-in: only the surface drawActionHighlight touches. */
interface FakeStyleLike {
  setProperty(name: string, value: string): void;
  getPropertyValue(name: string): string;
  get(name: string): string;
  [key: string]: unknown;
}

function createStyleStub(): FakeStyleLike {
  const values = new Map<string, string>();
  const api = {
    setProperty(name: string, value: string): void {
      values.set(name, value);
    },
    getPropertyValue(name: string): string {
      return values.get(name) ?? '';
    },
    get(name: string): string {
      return values.get(name) ?? '';
    },
  };
  // The renderer both calls setProperty and assigns style.top / style.left
  // directly; the proxy captures both shapes in the same store.
  return new Proxy(api, {
    get(target, property, receiver): unknown {
      if (typeof property === 'string' && property in target) {
        return Reflect.get(target, property, receiver);
      }
      return values.get(String(property)) ?? '';
    },
    set(_target, property, value): boolean {
      values.set(String(property), String(value));
      return true;
    },
  }) as FakeStyleLike;
}

class FakeElement {
  id = '';
  textContent = '';
  parent: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly style = createStyleStub();
  rect = { top: 100, left: 50, width: 200, height: 30 };

  constructor(readonly ownerDocument: FakeDocument) {}

  getBoundingClientRect(): { top: number; left: number; width: number; height: number } {
    return this.rect;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get firstElementChild(): FakeElement | undefined {
    return this.children[0];
  }
}

class FakeDocument {
  readonly documentElement: FakeElement;

  constructor() {
    this.documentElement = new FakeElement(this);
  }

  createElement(): FakeElement {
    return new FakeElement(this);
  }

  getElementById(id: string): FakeElement | null {
    const visit = (element: FakeElement): FakeElement | null => {
      if (element.id === id) return element;
      for (const child of element.children) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this.documentElement);
  }
}

describe('action highlight overlay', () => {
  let documentStub: FakeDocument;
  let target: FakeElement;

  beforeEach(() => {
    vi.useFakeTimers();
    documentStub = new FakeDocument();
    target = new FakeElement(documentStub);
    documentStub.documentElement.append(target);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders an independent overlay ring and action label without touching the target', () => {
    drawActionHighlight(target as unknown as Element, 'click');

    const root = documentStub.getElementById(ACTION_HIGHLIGHT_ROOT_ID);
    expect(root).not.toBeNull();
    expect(root?.parent).toBe(documentStub.documentElement);
    expect(root?.style.get('pointer-events')).toBe('none');
    expect(root?.style.get('z-index')).toBe('2147483647');

    const [ring, tag] = root?.children ?? [];
    expect(ring?.style.get('position')).toBe('fixed');
    expect(ring?.style.get('border')).toBe('2px solid #2563eb');
    expect(ring?.style.get('pointer-events')).toBe('none');
    expect(ring?.style.get('top')).toBe('98px');
    expect(ring?.style.get('left')).toBe('48px');
    expect(ring?.style.get('width')).toBe('204px');
    expect(ring?.style.get('height')).toBe('34px');
    expect(tag?.textContent).toBe('EV · click');
    expect(tag?.style.get('top')).toBe('80px');

    // The target element itself keeps its style and layout untouched.
    expect(target.children).toHaveLength(0);
  });

  it('moves the label below the element when there is no room above', () => {
    target.rect = { top: 10, left: 0, width: 80, height: 20 };
    drawActionHighlight(target as unknown as Element, 'type');

    const root = documentStub.getElementById(ACTION_HIGHLIGHT_ROOT_ID);
    const tag = root?.children[1];
    expect(tag?.style.get('top')).toBe('34px');
  });

  it('removes the highlight after the display window', () => {
    drawActionHighlight(target as unknown as Element, 'focus');
    expect(documentStub.getElementById(ACTION_HIGHLIGHT_ROOT_ID)).not.toBeNull();

    vi.advanceTimersByTime(ACTION_HIGHLIGHT_DURATION_MS - 1);
    expect(documentStub.getElementById(ACTION_HIGHLIGHT_ROOT_ID)).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(documentStub.getElementById(ACTION_HIGHLIGHT_ROOT_ID)).toBeNull();
  });

  it('keeps consecutive highlights separate and bounds their number', () => {
    for (let index = 0; index < 10; index += 1) {
      drawActionHighlight(target as unknown as Element, `click${index}`);
    }
    const root = documentStub.getElementById(ACTION_HIGHLIGHT_ROOT_ID);
    expect(root).not.toBeNull();
    expect(root?.childElementCount).toBeLessThanOrEqual(16);
    expect(root?.childElementCount).toBeGreaterThan(0);

    vi.advanceTimersByTime(ACTION_HIGHLIGHT_DURATION_MS);
    expect(documentStub.getElementById(ACTION_HIGHLIGHT_ROOT_ID)).toBeNull();
  });

  it('skips zero-size elements', () => {
    target.rect = { top: 0, left: 0, width: 0, height: 0 };
    drawActionHighlight(target as unknown as Element, 'click');
    expect(documentStub.getElementById(ACTION_HIGHLIGHT_ROOT_ID)).toBeNull();
  });

  it('builds a CDP declaration from the same rendering source', () => {
    const declaration = cdpHighlightDeclaration();
    expect(declaration).toContain('function evActionHighlight(label)');
    // The shared renderer travels verbatim inside the declaration.
    expect(declaration).toContain(drawActionHighlight.toString());
  });
});
