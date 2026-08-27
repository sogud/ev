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
  pairedBrowsers: [],
  pendingPairings: [],
  lastError: null,
};

describe('BrowserBridgeContent', () => {
  it('shows one-click approval for an automatic pairing request without manual credentials', () => {
    const html = renderMarkup(
      <BrowserBridgeContent
        snapshot={{
          ...baseSnapshot,
          pendingPairings: [
            {
              browserId: 'browser-id',
              browserName: 'Chrome',
              extensionVersion: '1.0.0',
              origin: 'chrome-extension://extension-id',
              requestedAt: Date.now(),
            },
          ],
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

  it('lists every paired browser with its online state', () => {
    const html = renderMarkup(
      <BrowserBridgeContent
        snapshot={{
          ...baseSnapshot,
          status: 'connected',
          pairedBrowsers: [
            {
              browserId: 'browser-work',
              browserName: 'Chrome',
              origin: 'chrome-extension://extension-id',
              online: true,
              connectedAt: Date.now(),
              lastSeenAt: Date.now(),
            },
            {
              browserId: 'browser-personal',
              browserName: 'Edge',
              origin: 'chrome-extension://extension-id',
              online: false,
              connectedAt: null,
              lastSeenAt: null,
            },
          ],
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRefresh={vi.fn()}
        onReconnect={vi.fn()}
        onRevoke={vi.fn()}
      />
    );

    expect(html).toContain('Chrome');
    expect(html).toContain('Edge');
    expect(html).toContain('browser-work');
    expect(html).toContain('browser-personal');
    expect(html).toContain('当前在线');
    expect(html).toContain('等待自动重连');
    expect(html).not.toContain('2 个在线'); // only one is online
    expect(html).toContain('1 个在线');
    // two paired browsers expose the bulk revoke action
    expect(html).toContain('撤销全部配对');
  });
});
