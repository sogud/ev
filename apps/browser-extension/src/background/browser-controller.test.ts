import { beforeEach, describe, expect, test, vi } from 'vitest';
import { executeBrowserCommand, resetBrowserControllerForTests } from './browser-controller';

interface DebuggerCall {
  method: string;
  params?: Record<string, unknown>;
}

describe('CDP browser controller', () => {
  const calls: DebuggerCall[] = [];
  const eventListeners = new Set<(...args: unknown[]) => void>();
  const detachListeners = new Set<(...args: unknown[]) => void>();
  const permissionContains = vi.fn(async () => true);

  beforeEach(() => {
    calls.length = 0;
    eventListeners.clear();
    detachListeners.clear();
    permissionContains.mockReset();
    permissionContains.mockResolvedValue(true);
    globalThis.chrome = {
      tabs: {
        query: vi.fn(async () => [
          { id: 7, active: true, windowId: 1, url: 'https://example.com' },
        ]),
        get: vi.fn(async () => ({
          id: 7,
          active: true,
          windowId: 1,
          url: 'https://example.com',
        })),
      },
      permissions: {
        contains: permissionContains,
      },
      downloads: {
        download: vi.fn(async () => 55),
        search: vi.fn(async () => [
          {
            id: 55,
            state: 'complete',
            filename: '/Users/test/Downloads/EV/photo.jpg',
          },
        ]),
      },
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        onEvent: {
          addListener: vi.fn(listener =>
            eventListeners.add(listener as (...args: unknown[]) => void)
          ),
          removeListener: vi.fn(listener =>
            eventListeners.delete(listener as (...args: unknown[]) => void)
          ),
        },
        onDetach: {
          addListener: vi.fn(listener =>
            detachListeners.add(listener as (...args: unknown[]) => void)
          ),
          removeListener: vi.fn(listener =>
            detachListeners.delete(listener as (...args: unknown[]) => void)
          ),
        },
        sendCommand: vi.fn(async (_target, method: string, params?: Record<string, unknown>) => {
          calls.push({ method, params });
          if (method === 'Accessibility.getFullAXTree') {
            return {
              nodes: [
                {
                  nodeId: 'ax-1',
                  role: { value: 'button' },
                  name: { value: 'Save' },
                  backendDOMNodeId: 44,
                },
              ],
            };
          }
          if (method === 'DOM.getBoxModel') {
            return { model: { border: [10, 20, 110, 20, 110, 60, 10, 60] } };
          }
          if (
            method === 'Runtime.evaluate' &&
            typeof params?.expression === 'string' &&
            params.expression.includes('resourceUrls')
          ) {
            return {
              result: {
                value: {
                  pageUrl: 'https://example.com/watch',
                  items: [
                    {
                      kind: 'image',
                      url: 'https://cdn.example.com/photo.jpg?token=secret',
                      width: 1200,
                      height: 800,
                    },
                  ],
                  resourceUrls: [
                    'https://cdn.example.com/video/master.m3u8?signature=stream-secret',
                  ],
                  skippedBlobMedia: 1,
                },
              },
            };
          }
          return {};
        }),
      },
    } as unknown as typeof chrome;
    resetBrowserControllerForTests();
  });

  test('creates snapshot refs and uses CDP trusted input for a click', async () => {
    const snapshot = (await executeBrowserCommand({
      action: 'page.snapshot',
      tabId: 7,
      mode: 'interactive',
    })) as { nodes: Array<{ ref: string; role: string; name: string }> };

    expect(snapshot.nodes).toEqual([{ ref: '@e1', role: 'button', name: 'Save' }]);

    await executeBrowserCommand({ action: 'page.click', tabId: 7, selector: '@e1' });
    expect(calls).toContainEqual({
      method: 'DOM.scrollIntoViewIfNeeded',
      params: { backendNodeId: 44 },
    });
    expect(calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toEqual([
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 1 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: 60, y: 40, button: 'left', clickCount: 1 },
      },
    ]);
  });

  test('collects CDP diagnostics and supports advanced page controls', async () => {
    await executeBrowserCommand({ action: 'page.snapshot', tabId: 7 });
    for (const listener of eventListeners) {
      listener({ tabId: 7 }, 'Runtime.consoleAPICalled', {
        type: 'error',
        args: [{ value: 'boom' }],
      });
      listener({ tabId: 7 }, 'Network.requestWillBeSent', {
        request: {
          url: 'https://example.com/api',
          headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
          postData: 'password=secret',
        },
      });
    }

    const logs = (await executeBrowserCommand({ action: 'page.logs', tabId: 7 })) as {
      entries: DebuggerCall[];
    };
    const network = (await executeBrowserCommand({
      action: 'page.network',
      tabId: 7,
      urlIncludes: '/api',
    })) as { entries: DebuggerCall[] };
    expect(logs.entries).toHaveLength(1);
    expect(network.entries).toHaveLength(1);
    expect(network.entries[0]).toMatchObject({
      data: {
        request: {
          headers: { Authorization: '[redacted]', Accept: 'application/json' },
          postData: '[redacted]',
        },
      },
    });

    await executeBrowserCommand({
      action: 'page.upload',
      tabId: 7,
      selector: '@e1',
      filePaths: ['/tmp/report.pdf'],
    });
    expect(calls).toContainEqual({
      method: 'DOM.setFileInputFiles',
      params: { backendNodeId: 44, files: ['/tmp/report.pdf'] },
    });

    await executeBrowserCommand({
      action: 'page.emulate',
      tabId: 7,
      enabled: true,
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      touch: true,
    });
    expect(calls).toContainEqual({
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    });
  });

  test('discovers media refs and dispatches direct and streaming downloads', async () => {
    const media = (await executeBrowserCommand({
      action: 'page.media',
      tabId: 7,
    })) as {
      skippedBlobMedia: number;
      items: Array<{ ref: string; kind: string; url: string }>;
    };

    expect(media).toMatchObject({
      skippedBlobMedia: 1,
      items: [
        { ref: '@m1', kind: 'image', url: 'https://cdn.example.com/photo.jpg' },
        { ref: '@m2', kind: 'stream', url: 'https://cdn.example.com/video/master.m3u8' },
      ],
    });

    await expect(
      executeBrowserCommand({ action: 'page.download', tabId: 7, ref: '@m1' })
    ).resolves.toEqual({ backend: 'chrome', downloadId: 55 });
    expect(chrome.downloads.download).toHaveBeenCalledWith({
      url: 'https://cdn.example.com/photo.jpg?token=secret',
      filename: 'EV/photo.jpg',
      conflictAction: 'uniquify',
      saveAs: false,
    });

    await expect(
      executeBrowserCommand({ action: 'page.download', tabId: 7, ref: '@m2' })
    ).resolves.toEqual({
      backend: 'external',
      url: 'https://cdn.example.com/video/master.m3u8?signature=stream-secret',
      pageUrl: 'https://example.com/watch',
      mediaKind: 'stream',
    });
    await expect(
      executeBrowserCommand({ action: 'downloads.status', downloadId: 'chrome:55' })
    ).resolves.toMatchObject({
      downloadId: 'chrome:55',
      backend: 'chrome',
      state: 'complete',
      filename: '/Users/test/Downloads/EV/photo.jpg',
    });
  });

  test('requires explicit downloads permission before starting media downloads', async () => {
    await executeBrowserCommand({ action: 'page.media', tabId: 7 });
    permissionContains.mockResolvedValue(false);

    await expect(
      executeBrowserCommand({ action: 'page.download', tabId: 7, ref: '@m1' })
    ).rejects.toThrow('Media downloads are disabled');
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });

  test('reports an unavailable transport when the browser has no CDP debugger API', async () => {
    delete (chrome as unknown as { debugger?: typeof chrome.debugger }).debugger;
    resetBrowserControllerForTests();

    await expect(executeBrowserCommand({ action: 'browser.capabilities' })).resolves.toEqual({
      transport: 'unavailable',
      cdp: false,
      arbitraryEval: false,
      actions: [],
    });
    await expect(executeBrowserCommand({ action: 'tabs.list' })).rejects.toThrow(
      'Chrome CDP control is unavailable'
    );
  });

  test('reports CDP capabilities and releases an attached tab', async () => {
    const capabilities = (await executeBrowserCommand({
      action: 'browser.capabilities',
    })) as { transport: string; arbitraryEval: boolean };
    expect(capabilities).toMatchObject({ transport: 'cdp', arbitraryEval: false });

    await executeBrowserCommand({ action: 'page.snapshot', tabId: 7 });
    await executeBrowserCommand({ action: 'page.release', tabId: 7 });
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 7 });
  });
});
