import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { Transcript } from './Transcript';

function renderTranscript(content: string): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Transcript
        items={[
          { id: 'u1', kind: 'user', content: 'show data', timestamp: 1 },
          { id: 'a1', kind: 'assistant', content, timestamp: 2 },
        ]}
        running={false}
        onViewDiff={vi.fn()}
      />
    </I18nextProvider>
  );
}

describe('Transcript markdown', () => {
  it('renders pipe tables as semantic HTML tables', () => {
    const html = renderTranscript('| Name | Value |\n| --- | ---: |\n| EV | **fast** |');

    expect(html).toContain('<table class="doc-table">');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td><strong class="doc-strong">fast</strong></td>');
  });
});
