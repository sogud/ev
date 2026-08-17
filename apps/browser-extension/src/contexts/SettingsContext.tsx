import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { applyLanguagePreference } from '../i18n';
import {
  BACKGROUND_IMAGE_NAME_STORAGE_KEY,
  BACKGROUND_IMAGE_STORAGE_KEY,
} from '../shared/background-image';
import { DEFAULT_OPTIONS, type Options } from '../types';

interface SettingsContextType {
  settings: Options;
  isLoaded: boolean;
  updateSettings: (updates: Partial<Options>) => void;
  resetSettings: () => void;
}

const SETTINGS_KEYS: Array<keyof Options> = [
  'language',
  'showNewTabBookmarks',
  'actionHighlight',
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
  const [settings, setSettings] = useState<Options>(DEFAULT_OPTIONS);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    // Load settings from Chrome storage.
    chrome.storage.sync.get(DEFAULT_OPTIONS, items => {
      setSettings(items as Options);
      setIsLoaded(true);
    });
    return subscribeToSettingsStorage(setSettings);
  }, []);

  useEffect(() => {
    if (isLoaded) void applyLanguagePreference(settings.language);
  }, [isLoaded, settings.language]);

  const updateSettings = (updates: Partial<Options>) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    chrome.storage.sync.set(newSettings);
  };

  const resetSettings = () => {
    setSettings(DEFAULT_OPTIONS);
    chrome.storage.sync.set(DEFAULT_OPTIONS);
  };

  return (
    <SettingsContext.Provider value={{ settings, isLoaded, updateSettings, resetSettings }}>
      {children}
    </SettingsContext.Provider>
  );
};

export default SettingsContext;
