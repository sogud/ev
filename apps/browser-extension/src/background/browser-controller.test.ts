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
        query: vi.fn(async (query?: chrome.tabs.QueryInfo) =>
          query?.windowId === 9
            ? [{ id: 11, active: true, windowId: 9, url: 'https://example.com' }]
            : [{ id: 7, active: true, windowId: 1, url: 'https://example.com' }]
        ),
        get: vi.fn(async () => ({
          id: 7,
          active: true,
          windowId: 1,
          url: 'https://example.com',
        })),
        create: vi.fn(async (details: { url: string; windowId?: number; active?: boolean }) => ({
          id: 12,
          windowId: details.windowId ?? 1,
          active: details.active ?? true,
          url: details.url,
        })),
      },
      windows: {
        create: vi.fn(async (details: { url: string; focused?: boolean }) => ({
          id: 9,
          focused: details.focused ?? true,
        })),
      },
      permissions: {
        contains: permissionContains,
      },
      bookmarks: {
        getTree: vi.fn(async () => [
          {
            id: '0',
            title: '',
            children: [
              {
                id: '1',
                parentId: '0',
                title: 'Bookmarks bar',
                children: [{ id: '10', parentId: '1', title: 'EV docs', url: 'https://ev.dev' }],
              },
              { id: '2', parentId: '0', title: 'Other bookmarks', children: [] },
            ],
          },
        ]),
        create: vi.fn(async (details: { parentId?: string; title: string; url?: string }) => ({
          id:
            details.title === 'Recovered'
              ? '100'
              : details.title === 'Bookmarks bar'
                ? '101'
                : '102',
          parentId: details.parentId,
          title: details.title,
          url: details.url,
        })),
        update: vi.fn(async (id: string, changes: { title?: string; url?: string }) => ({
          id,
          title: changes.title ?? 'EV docs',
          url: changes.url ?? 'https://ev.dev',
        })),
        move: vi.fn(async (id: string, destination: { parentId?: string; index?: number }) => ({
          id,
          parentId: destination.parentId,
          title: 'EV docs',
        })),
        remove: vi.fn(async () => undefined),
        removeTree: vi.fn(async () => undefined),
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

  test('opens an unfocused window and tabs inside a specified window', async () => {
    await expect(
      executeBrowserCommand({
        action: 'windows.open',
        url: 'https://example.com',
        focused: false,
      })
    ).resolves.toEqual({ windowId: 9, tabId: 11, url: 'https://example.com' });
    expect(chrome.windows.create).toHaveBeenCalledWith({
      url: 'https://example.com',
      focused: false,
    });
    expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 9 });

    await expect(
      executeBrowserCommand({
        action: 'tabs.open',
        url: 'https://example.com/docs',
        windowId: 9,
        active: false,
      })
    ).resolves.toEqual({ id: 12, windowId: 9, url: 'https://example.com/docs' });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/docs',
      windowId: 9,
      active: false,
    });
  });

  test('reads a fixed main scope without accepting arbitrary selectors', async () => {
    await executeBrowserCommand({
      action: 'page.context',
      tabId: 7,
      scope: 'main',
      maxChars: 50_000,
    });

    expect(calls).toContainEqual({
      method: 'Runtime.evaluate',
      params: expect.objectContaining({
        expression: expect.stringContaining(`const root = document.querySelector('main')`),
      }),
    });
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

  test('keeps bookmarks available when the browser has no CDP debugger API', async () => {
    delete (chrome as unknown as { debugger?: typeof chrome.debugger }).debugger;
    resetBrowserControllerForTests();

    const capabilities = (await executeBrowserCommand({ action: 'browser.capabilities' })) as {
      transport: string;
      cdp: boolean;
      arbitraryEval: boolean;
      actions: string[];
    };
    expect(capabilities).toMatchObject({
      transport: 'unavailable',
      cdp: false,
      arbitraryEval: false,
    });
    expect(capabilities.actions).toContain('bookmarks.list');
    await expect(executeBrowserCommand({ action: 'bookmarks.list' })).resolves.toMatchObject({
      nodes: expect.any(Array),
    });
    await expect(executeBrowserCommand({ action: 'tabs.list' })).rejects.toThrow(
      'Chrome CDP control is unavailable'
    );
  });

  test('lists and exports bookmark paths without browser-internal ids in backups', async () => {
    await expect(
      executeBrowserCommand({ action: 'bookmarks.search', query: 'ev', maxNodes: 10 })
    ).resolves.toEqual({
      nodes: [
        {
          id: '10',
          parentId: '1',
          title: 'EV docs',
          url: 'https://ev.dev',
          path: 'Bookmarks bar',
        },
      ],
      truncated: false,
    });

    const backup = (await executeBrowserCommand({ action: 'bookmarks.export' })) as {
      exportedAt: string;
      tree: unknown[];
    };
    expect(Date.parse(backup.exportedAt)).not.toBeNaN();
    expect(backup.tree).toEqual([
      {
        title: 'Bookmarks bar',
        children: [{ title: 'EV docs', url: 'https://ev.dev' }],
      },
      { title: 'Other bookmarks' },
    ]);
  });

  test('creates, updates, moves, and removes bookmarks through typed actions', async () => {
    await executeBrowserCommand({
      action: 'bookmarks.create',
      parentId: '1',
      title: 'EV docs',
      url: 'https://ev.dev',
    });
    expect(chrome.bookmarks.create).toHaveBeenCalledWith({
      parentId: '1',
      title: 'EV docs',
      url: 'https://ev.dev',
    });

    await executeBrowserCommand({ action: 'bookmarks.update', id: '10', title: 'EV guide' });
    expect(chrome.bookmarks.update).toHaveBeenCalledWith('10', { title: 'EV guide' });

    await executeBrowserCommand({
      action: 'bookmarks.move',
      id: '10',
      parentId: '2',
      index: 0,
    });
    expect(chrome.bookmarks.move).toHaveBeenCalledWith('10', { parentId: '2', index: 0 });

    await executeBrowserCommand({ action: 'bookmarks.remove', id: '10' });
    expect(chrome.bookmarks.remove).toHaveBeenCalledWith('10');
    await executeBrowserCommand({
      action: 'bookmarks.removeTree',
      id: '11',
      confirm: 'REMOVE_BOOKMARK_TREE',
    });
    expect(chrome.bookmarks.removeTree).toHaveBeenCalledWith('11');
  });

  test('restores a backup into a new folder without replacing existing bookmarks', async () => {
    await expect(
      executeBrowserCommand({
        action: 'bookmarks.restore',
        parentId: '2',
        title: 'Recovered',
        tree: [
          {
            title: 'Bookmarks bar',
            children: [{ title: 'EV docs', url: 'https://ev.dev' }],
          },
        ],
      })
    ).resolves.toEqual({ restored: true, folderId: '100', topLevels: 1 });

    expect(chrome.bookmarks.create).toHaveBeenNthCalledWith(1, {
      parentId: '2',
      title: 'Recovered',
    });
    expect(chrome.bookmarks.create).toHaveBeenNthCalledWith(2, {
      parentId: '100',
      title: 'Bookmarks bar',
      url: undefined,
    });
    expect(chrome.bookmarks.create).toHaveBeenNthCalledWith(3, {
      parentId: '101',
      title: 'EV docs',
      url: 'https://ev.dev',
    });
    expect(chrome.bookmarks.remove).not.toHaveBeenCalled();
    expect(chrome.bookmarks.removeTree).not.toHaveBeenCalled();
  });

  test('reports CDP capabilities and releases an attached tab', async () => {
    const capabilities = (await executeBrowserCommand({
      action: 'browser.capabilities',
    })) as { transport: string; arbitraryEval: boolean; actions: string[] };
    expect(capabilities).toMatchObject({ transport: 'cdp', arbitraryEval: false });
    expect(capabilities.actions).toContain('bookmarks.restore');

    await executeBrowserCommand({ action: 'page.snapshot', tabId: 7 });
    await executeBrowserCommand({ action: 'page.release', tabId: 7 });
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 7 });
  });
});
