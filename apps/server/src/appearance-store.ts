import Store from './store';
import type { ThemePreference } from '@ev/contracts/domain';

export type LanguagePreference = 'en' | 'zh';

export interface AppearanceStore {
  getTheme(): ThemePreference;
  setTheme(theme: ThemePreference): void;
  getLanguage(): LanguagePreference | undefined;
  setLanguage(language: LanguagePreference | undefined): void;
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'en' || value === 'zh';
}

/** Headless variant: records preferences only; each client (desktop shell/web) applies them. */
export function createAppearanceStore(): AppearanceStore {
  // 'system' is the explicit sentinel for "follow the OS locale" (KV cannot store null).
  const store = new Store<{ theme: ThemePreference; language?: LanguagePreference | 'system' }>({
    name: 'appearance',
    defaults: { theme: 'system' },
  });

  return {
    getTheme(): ThemePreference {
      const theme = store.get('theme');
      return isThemePreference(theme) ? theme : 'system';
    },
    setTheme(theme: ThemePreference): void {
      store.set('theme', theme);
    },
    getLanguage(): LanguagePreference | undefined {
      const language = store.get('language');
      return isLanguagePreference(language) ? language : undefined;
    },
    setLanguage(language: LanguagePreference | undefined): void {
      store.set('language', language ?? 'system');
    },
  };
}
