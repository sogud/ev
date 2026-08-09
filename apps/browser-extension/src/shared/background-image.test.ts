import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_IMAGE_NAME_STORAGE_KEY,
  BACKGROUND_IMAGE_STORAGE_KEY,
  readBackgroundImageFile,
  readSavedBackgroundImage,
  removeBackgroundImage,
  saveBackgroundImage,
} from './background-image';

describe('background image storage', () => {
  const storage: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key];

    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({ ...storage })),
          set: vi.fn(async (values: Record<string, unknown>) => Object.assign(storage, values)),
          remove: vi.fn(async (keys: string[]) => {
            for (const key of keys) delete storage[key];
          }),
        },
      },
    } as unknown as typeof chrome;
  });

  it('stores and removes a validated data URL', async () => {
    const image = { dataUrl: 'data:image/png;base64,fixture', name: 'background.png' };

    await saveBackgroundImage(image);
    expect(await readSavedBackgroundImage()).toEqual(image);
    expect(storage[BACKGROUND_IMAGE_STORAGE_KEY]).toBe(image.dataUrl);
    expect(storage[BACKGROUND_IMAGE_NAME_STORAGE_KEY]).toBe(image.name);

    await removeBackgroundImage();
    expect(await readSavedBackgroundImage()).toBeNull();
  });

  it('rejects non-image files before reading them', async () => {
    const file = { type: 'text/plain', size: 12 } as File;
    await expect(readBackgroundImageFile(file)).rejects.toThrow('Please choose an image file');
  });
});
