import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_IMAGE_NAME_STORAGE_KEY,
  BACKGROUND_IMAGE_STORAGE_KEY,
} from '../shared/background-image';
import type { Options } from '../types';
import { applyCustomSettings, applySavedBackground } from './apply-settings';

class ClassListStub {
  private readonly values = new Set<string>();

  add(...tokens: string[]): void {
    tokens.forEach(token => this.values.add(token));
  }

  remove(...tokens: string[]): void {
    tokens.forEach(token => this.values.delete(token));
  }

  toggle(token: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(token);
    if (enabled) this.values.add(token);
    else this.values.delete(token);
    return enabled;
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }
}

function createStyleStub() {
  const values = new Map<string, string>();
  return {
    setProperty(name: string, value: string) {
      values.set(name, value);
    },
    getPropertyValue(name: string) {
      return values.get(name) ?? '';
    },
  };
}

const imageSettings: Options = {
  language: 'system',
  showNewTabBookmarks: true,
  theme: 'auto',
  sortBy: 'name',
  iconColor: { bookmark: '#737373', folder: '#737373' },
  background: { type: 'image', value: 'local', opacity: 75 },
  uiCustomization: { cardStyle: 'minimal', animationEnabled: true, compactMode: true },
};

describe('apply extension appearance settings', () => {
  const root = { classList: new ClassListStub(), style: createStyleStub() };
  const body = { classList: new ClassListStub() };

  beforeEach(() => {
    root.classList = new ClassListStub();
    root.style = createStyleStub();
    body.classList = new ClassListStub();
    globalThis.document = { documentElement: root, body } as unknown as Document;
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({
            [BACKGROUND_IMAGE_STORAGE_KEY]: 'data:image/png;base64,fixture',
            [BACKGROUND_IMAGE_NAME_STORAGE_KEY]: 'background.png',
          })),
        },
      },
    } as unknown as typeof chrome;
  });

  it('keeps a saved image applied when other appearance settings are reapplied', async () => {
    await applySavedBackground(imageSettings);
    applyCustomSettings(imageSettings);

    expect(root.classList.contains('ev-has-custom-background')).toBe(true);
    expect(root.style.getPropertyValue('--custom-background')).toBe(
      'url("data:image/png;base64,fixture")'
    );
    expect(root.style.getPropertyValue('--custom-background-opacity')).toBe('0.75');
  });

  it('falls back cleanly when an image preference has no saved image', async () => {
    globalThis.chrome = {
      storage: { local: { get: vi.fn(async () => ({})) } },
    } as unknown as typeof chrome;

    await applySavedBackground(imageSettings);

    expect(root.classList.contains('ev-has-custom-background')).toBe(false);
    expect(root.style.getPropertyValue('--custom-background')).toBe('none');
    expect(root.style.getPropertyValue('--custom-background-opacity')).toBe('0');
  });
});
