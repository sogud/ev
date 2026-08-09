import { initEvI18n } from '@ev/locales';

// `lang` query param pins the locale for golden/tests; otherwise the stored
// preference (fetched in boot) or the system locale decides.
const params = new URLSearchParams(window.location.search);
export const i18n = initEvI18n(params.get('lang'));
export const hasLangOverride = params.get('lang') !== null;
