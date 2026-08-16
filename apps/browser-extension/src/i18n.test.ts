import { beforeEach, describe, expect, it } from 'vitest';
import { applyLanguagePreference, i18n } from './i18n';

describe('browser extension language preference', () => {
  beforeEach(() => {
    globalThis.document = {
      documentElement: { lang: '' },
    } as unknown as Document;
  });

  it('switches all extension pages to the selected language', async () => {
    await applyLanguagePreference('zh');
    expect(i18n.t('browser.options.title')).toBe('EV Browser 设置');
    expect(document.documentElement.lang).toBe('zh-CN');

    await applyLanguagePreference('en');
    expect(i18n.t('browser.options.title')).toBe('EV Browser settings');
    expect(document.documentElement.lang).toBe('en');
  });
});
