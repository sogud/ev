import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  BACKGROUND_IMAGE_NAME_STORAGE_KEY,
  BACKGROUND_IMAGE_STORAGE_KEY,
} from '../shared/background-image';
import { Options } from '../types';

interface SettingsContextType {
  settings: Options;
  updateSettings: (updates: Partial<Options>) => void;
  resetSettings: () => void;
}

const defaultSettings: Options = {
  theme: 'auto',
  sortBy: 'name',
  iconColor: {
    bookmark: '#737373',
    folder: '#737373',
  },
  background: {
    type: 'color',
    value: 'transparent',
    opacity: 100,
  },
  uiCustomization: {
    cardStyle: 'minimal',
    animationEnabled: true,
    compactMode: true,
  },
};

const SETTINGS_KEYS: Array<keyof Options> = [
  'theme',
  'sortBy',
  'iconColor',
  'background',
  'uiCustomization',
];

export function applySettingsStorageChanges(
  current: Options,
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string
): Options {
  if (areaName === 'local') {
    const backgroundChanged =
      BACKGROUND_IMAGE_STORAGE_KEY in changes || BACKGROUND_IMAGE_NAME_STORAGE_KEY in changes;
    return backgroundChanged ? { ...current } : current;
  }
  if (areaName !== 'sync') return current;

  const next = { ...current };
  let changed = false;
  for (const key of SETTINGS_KEYS) {
    const change = changes[key];
    if (!change || change.newValue === undefined) continue;
    (next as unknown as Record<string, unknown>)[key] = change.newValue;
    changed = true;
  }
  return changed ? next : current;
}

export function subscribeToSettingsStorage(
  update: (updater: (current: Options) => Options) => void
): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    update(current => applySettingsStorageChanges(current, changes, areaName));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within SettingsProvider');
  }
  return context;
};

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<Options>(defaultSettings);

  useEffect(() => {
    // 从 Chrome 存储加载设置
    chrome.storage.sync.get(defaultSettings, items => {
      setSettings(items as Options);
    });
    return subscribeToSettingsStorage(setSettings);
  }, []);

  const updateSettings = (updates: Partial<Options>) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    chrome.storage.sync.set(newSettings);
  };

  const resetSettings = () => {
    setSettings(defaultSettings);
    chrome.storage.sync.set(defaultSettings);
  };

  return (
    <SettingsContext.Provider value={{ settings, updateSettings, resetSettings }}>
      {children}
    </SettingsContext.Provider>
  );
};

export default SettingsContext;
