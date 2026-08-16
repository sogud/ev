import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../i18n';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderSummary } from '../../shared/types';
import { buildModelPickerGroups, filterModelPickerItem, ModelPicker } from './ModelPicker';

const renderMarkup = (node: React.ReactNode): string =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

const provider: ProviderSummary = {
  id: 'fixture-provider',
  name: 'Fixture Provider',
  authStatus: 'configured',
  supportsApiKey: false,
  supportsOAuth: false,
  custom: false,
  models: [
    {
      id: 'available-model',
      name: 'Available Model',
      provider: 'fixture-provider',
      api: 'fixture',
      reasoning: true,
      contextWindow: 1,
      available: true,
    },
    {
      id: 'unavailable-model',
      name: 'Unavailable Model',
      provider: 'fixture-provider',
      api: 'fixture',
      reasoning: false,
      contextWindow: 1,
      available: false,
    },
  ],
};

describe('ModelPicker', () => {
  it('lists available models and preserves an unavailable selected model', () => {
    expect(buildModelPickerGroups([provider], '')[0]?.models.map(model => model.id)).toEqual([
      'available-model',
    ]);
    expect(
      buildModelPickerGroups([provider], 'fixture-provider/unavailable-model')[0]?.models.map(
        model => model.id
      )
    ).toEqual(['available-model', 'unavailable-model']);
  });

  it('matches model names, IDs, and providers using predictable substring search', () => {
    expect(
      filterModelPickerItem('fixture-provider/available-model', 'available', [
        'Available Model',
        'Fixture Provider',
      ])
    ).toBe(1);
    expect(
      filterModelPickerItem('fixture-provider/available-model', 'missing', [
        'Available Model',
        'Fixture Provider',
      ])
    ).toBe(0);
  });

  it('keeps the trigger visible when no provider is configured', () => {
    const html = renderMarkup(<ModelPicker providers={[]} value='' onValueChange={vi.fn()} />);

    expect(html).toContain('aria-label="选择模型"');
    expect(html).toContain('没有可用模型');
    expect(html).toContain('disabled=""');
  });
});
