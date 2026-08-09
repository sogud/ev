import { initEvI18n } from '@ev/locales';

// Bootstrap reads URL hash (desktop main injects) or query (web form).
// `lang` is an explicit override used by tests/golden to pin a locale;
// __EV_LANG__ lets the vitest setup pin a language in the node environment.
const params =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.hash.slice(1) || window.location.search)
    : new URLSearchParams();
export const langOverride =
  params.get('lang') ?? (globalThis as { __EV_LANG__?: string }).__EV_LANG__ ?? null;
export const i18n = initEvI18n(langOverride);
