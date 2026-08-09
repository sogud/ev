import { describe, expect, it, vi } from 'vitest';
import type { Options } from '../types';
import { applySettingsStorageChanges, subscribeToSettingsStorage } from './SettingsContext';
import { BACKGROUND_IMAGE_STORAGE_KEY } from '../shared/background-image';

const settings: Options = {
  theme: 'auto',
  sortBy: 'name',
  iconColor: { bookmark: '#737373', folder: '#737373' },
  background: { type: 'color', value: 'transparent', opacity: 100 },
  uiCustomization: { cardStyle: 'minimal', animationEnabled: true, compactMode: true },
};

describe('settings storage synchronization', () => {
  it('applies sync setting changes to an already loaded settings snapshot', () => {
    const next = applySettingsStorageChanges(
      settings,
      {
        background: {
          oldValue: settings.background,
          newValue: { type: 'image', value: 'local', opacity: 80 },
        },
      },
      'sync'
    );

    expect(next.background).toEqual({ type: 'image', value: 'local', opacity: 80 });
  });

  it('refreshes settings identity when the local background image changes', () => {
    const current: Options = {
      ...settings,
      background: { type: 'image', value: 'local', opacity: 100 },
    };
    const next = applySettingsStorageChanges(
      current,
      { [BACKGROUND_IMAGE_STORAGE_KEY]: { newValue: 'data:image/png;base64,new' } },
      'local'
    );

    expect(next).not.toBe(current);
    expect(next.background.type).toBe('image');
  });

  it('subscribes and unsubscribes from chrome storage changes', () => {
    let listener:
      ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | undefined;
    const addListener = vi.fn((value: typeof listener) => {
      listener = value;
    });
    const removeListener = vi.fn();
    globalThis.chrome = {
      storage: { onChanged: { addListener, removeListener } },
    } as unknown as typeof chrome;
    let current = settings;

    const unsubscribe = subscribeToSettingsStorage(updater => {
      current = updater(current);
    });
    listener?.(
      {
        background: {
          newValue: { type: 'image', value: 'local', opacity: 100 },
        },
      },
      'sync'
    );

    expect(current.background.type).toBe('image');
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(listener);
  });
});
