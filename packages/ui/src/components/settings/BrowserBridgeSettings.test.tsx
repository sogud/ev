import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../i18n';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserBridgeSnapshot } from '../../shared/types';
import { BrowserBridgeContent } from './BrowserBridgeSettings';

const renderMarkup = (node: React.ReactNode): string =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

const baseSnapshot: BrowserBridgeSnapshot = {
  status: 'listening',
  endpoint: 'ws://127.0.0.1:43121/browser',
  pairingToken: null,
  pairedOrigin: null,
  browserId: null,
  pendingPairing: null,
  connectedAt: null,
  lastSeenAt: null,
  lastError: null,
};

describe('BrowserBridgeContent', () => {
  it('shows one-click approval for an automatic pairing request without manual credentials', () => {
    const html = renderMarkup(
      <BrowserBridgeContent
        snapshot={{
          ...baseSnapshot,
          pendingPairing: {
            browserId: 'browser-id',
            browserName: 'Chrome',
            extensionVersion: '1.0.0',
            origin: 'chrome-extension://extension-id',
            requestedAt: Date.now(),
          },
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRefresh={vi.fn()}
        onReconnect={vi.fn()}
        onRevoke={vi.fn()}
      />
    );

    expect(html).toContain('Chrome 请求连接');
    expect(html).toContain('允许连接');
    expect(html).toContain('拒绝');
    expect(html).not.toContain('Pairing token');
    expect(html).not.toContain('复制 Desktop 地址');
  });

  it('shows refresh and reconnect controls for connection maintenance', () => {
    const html = renderMarkup(
      <BrowserBridgeContent
        snapshot={{ ...baseSnapshot, status: 'connected' }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRefresh={vi.fn()}
        onReconnect={vi.fn()}
        onRevoke={vi.fn()}
      />
    );

    expect(html).toContain('刷新状态');
    expect(html).toContain('请求重连');
  });
});
