import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { i18n } from '../../i18n';
import { NewTabSurface } from './index';

describe('new-tab preference', () => {
  it('renders a blank page without mounting bookmark content when disabled', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <NewTabSurface showBookmarks={false} />
      </I18nextProvider>
    );

    expect(html).toContain('ev-blank-newtab');
    expect(html).not.toContain('EV Browser');
  });
});
