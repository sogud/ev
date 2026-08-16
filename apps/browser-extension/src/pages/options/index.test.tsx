import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { i18n } from '../../i18n';
import { OptionsPage } from './index';

async function renderOptions(language: 'en' | 'zh'): Promise<string> {
  await i18n.changeLanguage(language);
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <OptionsPage />
    </I18nextProvider>
  );
}

describe('browser extension settings UI', () => {
  it('renders the language and new-tab controls in English', async () => {
    const html = await renderOptions('en');

    expect(html).toContain('EV Browser settings');
    expect(html).toContain('Show EV Browser on new tabs');
    expect(html).toContain('Language');
    expect(html.match(/Enabled/g)).toHaveLength(3);
  });

  it('renders the same controls in Chinese', async () => {
    const html = await renderOptions('zh');

    expect(html).toContain('EV Browser 设置');
    expect(html).toContain('在新标签页显示 EV Browser');
    expect(html).toContain('语言');
    expect(html.match(/已开启/g)).toHaveLength(3);
  });
});
