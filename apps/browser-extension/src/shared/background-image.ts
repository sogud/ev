export const BACKGROUND_IMAGE_STORAGE_KEY = 'ev_browser_background_image';
export const BACKGROUND_IMAGE_NAME_STORAGE_KEY = 'ev_browser_background_image_name';
export const MAX_BACKGROUND_IMAGE_BYTES = 4 * 1024 * 1024;

export interface SavedBackgroundImage {
  dataUrl: string;
  name: string;
}

export async function readSavedBackgroundImage(): Promise<SavedBackgroundImage | null> {
  const stored = await chrome.storage.local.get([
    BACKGROUND_IMAGE_STORAGE_KEY,
    BACKGROUND_IMAGE_NAME_STORAGE_KEY,
  ]);
  const dataUrl = stored[BACKGROUND_IMAGE_STORAGE_KEY];
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return null;
  }

  const name = stored[BACKGROUND_IMAGE_NAME_STORAGE_KEY];
  return {
    dataUrl,
    name: typeof name === 'string' && name.trim() ? name : '自定义背景',
  };
}

export async function saveBackgroundImage(image: SavedBackgroundImage): Promise<void> {
  await chrome.storage.local.set({
    [BACKGROUND_IMAGE_STORAGE_KEY]: image.dataUrl,
    [BACKGROUND_IMAGE_NAME_STORAGE_KEY]: image.name,
  });
}

export async function removeBackgroundImage(): Promise<void> {
  await chrome.storage.local.remove([
    BACKGROUND_IMAGE_STORAGE_KEY,
    BACKGROUND_IMAGE_NAME_STORAGE_KEY,
  ]);
}

export function readBackgroundImageFile(file: File): Promise<SavedBackgroundImage> {
  if (!file.type.startsWith('image/')) {
    return Promise.reject(new Error('请选择图片文件'));
  }
  if (file.size > MAX_BACKGROUND_IMAGE_BYTES) {
    return Promise.reject(new Error('背景图片不能超过 4 MB'));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.startsWith('data:image/')) {
        reject(new Error('无法读取背景图片'));
        return;
      }
      resolve({ dataUrl: reader.result, name: file.name });
    };
    reader.onerror = () => reject(new Error('无法读取背景图片'));
    reader.readAsDataURL(file);
  });
}
