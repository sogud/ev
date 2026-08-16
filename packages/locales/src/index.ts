import i18n, { type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import zh from './zh.json';

export type EvLanguage = 'en' | 'zh';

export const EV_LANGUAGES: EvLanguage[] = ['en', 'zh'];

/** Stored preference wins, then system locale, then English. */
export function resolveLanguage(stored: string | null | undefined): EvLanguage {
  if (stored === 'en' || stored === 'zh') return stored;
  const system = typeof navigator !== 'undefined' ? navigator.language : (process.env.LANG ?? 'en');
  return system.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * Shared i18next bootstrap for every EV UI (desktop renderer, mobile, browser extension).
 * Resources live in en.json/zh.json — the single source of truth.
 */
export function initEvI18n(language?: string | null): I18n {
  const instance = i18n.createInstance();
  void instance.use(initReactI18next).init({
    resources: { en: { translation: en }, zh: { translation: zh } },
    lng: resolveLanguage(language),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}

export { en, zh };
