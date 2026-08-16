import { initEvI18n, resolveLanguage, type EvLanguage } from '@ev/locales';
import type { Options } from './types';

export const i18n = initEvI18n();

export async function applyLanguagePreference(language: Options['language']): Promise<EvLanguage> {
  const resolved = resolveLanguage(language === 'system' ? null : language);
  if (i18n.resolvedLanguage !== resolved) {
    await i18n.changeLanguage(resolved);
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = resolved === 'zh' ? 'zh-CN' : 'en';
  }
  return resolved;
}
