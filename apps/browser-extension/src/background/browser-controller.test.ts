import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetActionHighlightForTests } from './action-highlight';
import { executeBrowserCommand, resetBrowserControllerForTests } from './browser-controller';

interface DebuggerCall {
  method: string;
  params?: Record<string, unknown>;
}

describe('CDP browser controller', () => {
  const calls: DebuggerCall[] = [];
  const eventListeners = new Set<(...args: unknown[]) => void>();
  const detachListeners = new Set<(...args: unknown[]) => void>();
  const tabCreatedListeners = new Set<(tab: chrome.tabs.Tab) => void>();
  const downloadCreatedListeners = new Set<(item: chrome.downloads.DownloadItem) => void>();
  const permissionContains = vi.fn(async () => true);
  const pageBridge = vi.fn();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    calls.length = 0;
    eventListeners.clear();
    detachListeners.clear();
    tabCreatedListeners.clear();
    downloadCreatedListeners.clear();
    permissionContains.mockReset();
    permissionContains.mockResolvedValue(true);
    pageBridge.mockReset();
    // Highlights default to disabled in the shared mock; individual tests opt in.
    pageBridge.mockResolvedValue({ tools: [] });
    globalThis.chrome = {
      tabs: {
        query: vi.fn(async (query?: chrome.tabs.QueryInfo) =>
          query?.windowId === 9
            ? [{ id: 11, active: true, windowId: 9, url: 'https://example.com' }]
            : [{ id: 7, active: true, windowId: 1, url: 'https://example.com' }]
        ),
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          active: true,
          windowId: 1,
          index: 0,
          pinned: false,
          highlighted: true,
          incognito: false,
          selected: true,
          discarded: false,
          autoDiscardable: true,
          groupId: -1,
          title: 'Example',
          url: 'https://example.com',
        })),
        create: vi.fn(async (details: { url: string; windowId?: number; active?: boolean }) => ({
          id: 12,
          windowId: details.windowId ?? 1,
          active: details.active ?? true,
          url: details.url,
        })),
        update: vi.fn(async (tabId: number, changes: chrome.tabs.UpdateProperties) => ({
          id: tabId,
          windowId: 1,
          index: 0,
          active: changes.active ?? true,
          pinned: changes.pinned ?? false,
          mutedInfo: { muted: changes.muted ?? false },
          highlighted: true,
          incognito: false,
          selected: true,
          discarded: false,
          autoDiscardable: true,
          groupId: -1,
          url: changes.url ?? 'https://example.com',
        })),
        move: vi.fn(async (tabId: number, details: chrome.tabs.MoveProperties) => ({
          id: tabId,
          windowId: details.windowId ?? 1,
          index: details.index,
          active: true,
          pinned: false,
          highlighted: true,
          incognito: false,
          selected: true,
          discarded: false,
          autoDiscardable: true,
          groupId: -1,
        })),
        duplicate: vi.fn(async (tabId: number) => ({
          id: tabId + 100,
          windowId: 1,
          index: 1,
          active: true,
          pinned: false,
          highlighted: true,
          incognito: false,
          selected: true,
          discarded: false,
          autoDiscardable: true,
          groupId: -1,
        })),
        discard: vi.fn(async (tabId: number) => ({
          id: tabId,
          windowId: 1,
          index: 0,
          active: false,
          pinned: false,
          highlighted: false,
          incognito: false,
          selected: false,
          discarded: true,
          autoDiscardable: true,
          groupId: -1,
        })),
        remove: vi.fn(async () => undefined),
        group: vi.fn(async () => 4),
        ungroup: vi.fn(async () => undefined),
        getZoom: vi.fn(async () => 1),
        setZoom: vi.fn(async () => undefined),
        sendMessage: pageBridge,
        onCreated: {
          addListener: vi.fn(listener => tabCreatedListeners.add(listener)),
          removeListener: vi.fn(listener => tabCreatedListeners.delete(listener)),
        },
      },
      windows: {
        getAll: vi.fn(async () => [
          { id: 1, focused: true, incognito: false, type: 'normal', state: 'normal' },
        ]),
        create: vi.fn(async (details: { url: string; focused?: boolean }) => ({
          id: 9,
          focused: details.focused ?? true,
        })),
        update: vi.fn(async (windowId: number, changes: chrome.windows.UpdateInfo) => ({
          id: windowId,
          focused: changes.focused ?? true,
          incognito: false,
          type: 'normal',
          state: changes.state ?? 'normal',
        })),
        remove: vi.fn(async () => undefined),
      },
      tabGroups: {
        query: vi.fn(async () => [
          { id: 4, windowId: 1, collapsed: false, color: 'blue', title: 'Research' },
        ]),
        get: vi.fn(async (groupId: number) => ({
          id: groupId,
          windowId: 1,
          collapsed: false,
          color: 'blue',
          title: 'Research',
        })),
        update: vi.fn(async (groupId: number, changes: chrome.tabGroups.UpdateProperties) => ({
          id: groupId,
          windowId: 1,
          collapsed: changes.collapsed ?? false,
          color: changes.color ?? 'blue',
          title: changes.title ?? 'Research',
        })),
      },
      permissions: {
        contains: permissionContains,
      },
      storage: {
        sync: {
          get: vi.fn(async () => ({ actionHighlight: false })),
          set: vi.fn(async () => undefined),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
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
        pause: vi.fn(async () => undefined),
        resume: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        open: vi.fn(async () => undefined),
        show: vi.fn(),
        removeFile: vi.fn(async () => undefined),
        erase: vi.fn(async (query: chrome.downloads.DownloadQuery) => query.id ?? []),
        onCreated: {
          addListener: vi.fn(listener => downloadCreatedListeners.add(listener)),
          removeListener: vi.fn(listener => downloadCreatedListeners.delete(listener)),
        },
      },
      history: {
        search: vi.fn(async () => [
          {
            id: 'https://example.com',
            url: 'https://example.com',
            title: 'Example',
            visitCount: 2,
          },
        ]),
        getVisits: vi.fn(async () => [
          {
            id: 'visit-1',
            visitId: 'visit-1',
            visitTime: 1_500,
            referringVisitId: '0',
            transition: 'link',
          },
        ]),
        deleteUrl: vi.fn(async () => undefined),
        deleteRange: vi.fn(async () => undefined),
        deleteAll: vi.fn(async () => undefined),
      },
      sessions: {
        getRecentlyClosed: vi.fn(async () => [
          {
            tab: {
              sessionId: 'recent-tab',
              id: 8,
              windowId: 1,
              index: 0,
              active: false,
              pinned: false,
              highlighted: false,
              incognito: false,
              selected: false,
              discarded: false,
              autoDiscardable: true,
              groupId: -1,
              title: 'Closed',
              url: 'https://example.com/closed',
            },
          },
        ]),
        restore: vi.fn(async () => ({
          tab: {
            sessionId: 'recent-tab',
            id: 18,
            windowId: 1,
            index: 0,
            active: true,
            pinned: false,
            highlighted: true,
            incognito: false,
            selected: true,
            discarded: false,
            autoDiscardable: true,
            groupId: -1,
            url: 'https://example.com/closed',
          },
        })),
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
          if (method === 'DOM.resolveNode') {
            return { object: { objectId: 'object-1' } };
          }
          if (method === 'Page.createIsolatedWorld') {
            return { executionContextId: 91 };
          }
          if (method === 'Page.getNavigationHistory') {
            return {
              currentIndex: 1,
              entries: [
                { id: 10, url: 'https://example.com/previous' },
                { id: 11, url: 'https://example.com/current' },
                { id: 12, url: 'https://example.com/next' },
              ],
            };
          }
          if (method === 'Runtime.callFunctionOn') {
            const declaration = String(params?.functionDeclaration ?? '');
            if (declaration.includes('evReadCheckState')) {
              return { result: { value: { checkable: true, checked: false } } };
            }
            if (declaration.includes('evSelectOptions')) {
              return { result: { value: { selectedValues: ['ca'] } } };
            }
            if (declaration.includes('evInspectElement')) {
              return {
                result: {
                  value: {
                    tagName: 'input',
                    role: 'textbox',
                    value: 'Draft',
                    checked: false,
                    disabled: false,
                    attributes: { 'aria-label': 'Title' },
                  },
                },
              };
            }
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
    resetActionHighlightForTests();
  });

  test('coalesces concurrent debugger attachment for one tab', async () => {
    let finishAttach!: () => void;
    const attachPending = new Promise<void>(resolve => (finishAttach = resolve));
    vi.mocked(chrome.debugger.attach).mockImplementation(() => attachPending);

    const advancedCommands = [
      executeBrowserCommand({ action: 'page.pointer', tabId: 7, type: 'move', x: 10, y: 20 }),
      executeBrowserCommand({ action: 'page.pointer', tabId: 7, type: 'move', x: 20, y: 30 }),
      executeBrowserCommand({ action: 'page.pointer', tabId: 7, type: 'move', x: 30, y: 40 }),
    ];
    await Promise.resolve();
    await Promise.resolve();
    const attachCalls = vi.mocked(chrome.debugger.attach).mock.calls.length;
    finishAttach();
    await Promise.all(advancedCommands);

    expect(attachCalls).toBe(1);
  });

  test('detaches the debugger after the idle window and re-attaches on demand', async () => {
    vi.useFakeTimers();
    try {
      await executeBrowserCommand({ action: 'page.pointer', tabId: 7, type: 'move', x: 1, y: 2 });
      expect(vi.mocked(chrome.debugger.attach)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(chrome.debugger.detach)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(vi.mocked(chrome.debugger.detach)).toHaveBeenCalledWith({ tabId: 7 });

      await executeBrowserCommand({ action: 'page.pointer', tabId: 7, type: 'move', x: 3, y: 4 });
      expect(vi.mocked(chrome.debugger.attach)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps the debugger attached while an advanced command is still in flight', async () => {
    vi.useFakeTimers();
    let finishPointer!: () => void;
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(
      async (_target, method: string, params?: object) => {
        calls.push({ method, params: params as Record<string, unknown> | undefined });
        if (method === 'Input.dispatchMouseEvent') {
          await new Promise<void>(resolve => {
            finishPointer = resolve;
          });
        }
        return {};
      }
    );
    try {
      const pending = executeBrowserCommand({
        action: 'page.pointer',
        tabId: 7,
        type: 'move',
        x: 1,
        y: 2,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.mocked(chrome.debugger.detach)).not.toHaveBeenCalled();

      finishPointer();
      await pending;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(vi.mocked(chrome.debugger.detach)).toHaveBeenCalledWith({ tabId: 7 });
    } finally {
      vi.useRealTimers();
    }
  });

  test('uses fixed content-script operations for common page actions without CDP', async () => {
    const executeScript = vi.fn(async (injection: { args?: unknown[] }) => {
      const operation = injection.args?.[0] as { kind?: string } | undefined;
      if (operation?.kind === 'snapshot') {
        return [
          {
            frameId: 0,
            result: {
              nodes: [{ ref: '@e1', role: 'button', name: 'Save', selector: '#save' }],
              truncated: false,
            },
          },
        ];
      }
      if (operation?.kind === 'mediaHint') {
        return [
          {
            frameId: 0,
            result: {
              mediaUrl: 'https://media.example.com/audio.m4a?signature=secret',
              userAgent: 'EV Test Browser',
            },
          },
        ];
      }
      if (operation?.kind === 'context') {
        return [
          {
            frameId: 0,
            result: {
              url: 'https://example.com',
              title: 'Example',
              text: 'Page text',
              capturedAt: '2026-08-15T00:00:00.000Z',
            },
          },
        ];
      }
      if (operation?.kind === 'click') {
        return [{ frameId: 0, result: { clicked: true, x: 10, y: 20 } }];
      }
      if (operation?.kind === 'type') {
        return [{ frameId: 0, result: { typed: true, textLength: 5 } }];
      }
      if (operation?.kind === 'setChecked') {
        return [{ frameId: 0, result: { checked: true, changed: true } }];
      }
      if (operation?.kind === 'select') {
        return [{ frameId: 0, result: { selectedValues: ['ca'] } }];
      }
      if (operation?.kind === 'focus') {
        return [{ frameId: 0, result: { focused: true } }];
      }
      if (operation?.kind === 'inspect') {
        return [{ frameId: 0, result: { tagName: 'button', attributes: {} } }];
      }
      if (operation?.kind === 'scroll') {
        return [{ frameId: 0, result: { x: 0, y: 600 } }];
      }
      if (operation?.kind === 'waitTarget') {
        return [{ frameId: 0, result: { condition: 'target', matched: true, elapsedMs: 1 } }];
      }
      return [{ frameId: 0, result: { operation: 'back' } }];
    });
    (
      globalThis.chrome as unknown as { scripting: { executeScript: typeof executeScript } }
    ).scripting = { executeScript };
    const captureVisibleTab = vi.fn(async () => 'data:image/png;base64,cG5n');
    (
      globalThis.chrome.tabs as unknown as {
        captureVisibleTab: typeof captureVisibleTab;
      }
    ).captureVisibleTab = captureVisibleTab;
    resetBrowserControllerForTests();

    await expect(
      executeBrowserCommand({ action: 'page.snapshot', tabId: 7, mode: 'interactive' })
    ).resolves.toMatchObject({ nodes: [{ ref: '@e1', role: 'button', name: 'Save' }] });
    await expect(
      executeBrowserCommand({ action: 'page.click', tabId: 7, selector: '@e1' })
    ).resolves.toMatchObject({ clicked: true, selector: '@e1' });
    await expect(
      executeBrowserCommand({ action: 'page.context', tabId: 7 })
    ).resolves.toMatchObject({ text: 'Page text' });
    await executeBrowserCommand({ action: 'page.history', tabId: 7, operation: 'back' });
    await executeBrowserCommand({
      action: 'page.type',
      tabId: 7,
      selector: '#input',
      text: 'hello',
    });
    await executeBrowserCommand({
      action: 'page.setChecked',
      tabId: 7,
      selector: '#remember',
      checked: true,
    });
    await executeBrowserCommand({
      action: 'page.select',
      tabId: 7,
      selector: '#country',
      values: ['ca'],
    });
    await executeBrowserCommand({ action: 'page.focus', tabId: 7, selector: '#input' });
    await executeBrowserCommand({ action: 'page.inspect', tabId: 7, selector: '#input' });
    await executeBrowserCommand({ action: 'page.scroll', tabId: 7, direction: 'down' });
    await executeBrowserCommand({
      action: 'page.wait',
      tabId: 7,
      condition: 'target',
      selector: '#ready',
    });
    await executeBrowserCommand({ action: 'page.wait', tabId: 7, timeMs: 0 });
    await expect(
      executeBrowserCommand({ action: 'page.screenshot', tabId: 7 })
    ).resolves.toMatchObject({ data: 'cG5n', fullPage: false });
    await executeBrowserCommand({
      action: 'page.navigate',
      tabId: 7,
      url: 'https://example.com/next',
    });

    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(executeScript).toHaveBeenCalledTimes(11);
    expect(captureVisibleTab).toHaveBeenCalledWith(1, { format: 'png' });
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { url: 'https://example.com/next' });
  });

  test('waits for a newly created tab to receive its HTTP URL', async () => {
    const tab = {
      id: 7,
      active: true,
      windowId: 1,
      index: 0,
      pinned: false,
      highlighted: true,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      title: 'Example',
    } satisfies chrome.tabs.Tab;
    vi.mocked(chrome.tabs.get)
      .mockResolvedValueOnce({ ...tab, pendingUrl: 'https://example.com' })
      .mockResolvedValueOnce({ ...tab, url: 'https://example.com' });
    const executeScript = vi.fn(async () => [
      {
        frameId: 0,
        result: {
          url: 'https://example.com',
          title: 'Example',
          text: 'Ready',
          capturedAt: '2026-08-29T00:00:00.000Z',
        },
      },
    ]);
    (
      globalThis.chrome as unknown as { scripting: { executeScript: typeof executeScript } }
    ).scripting = { executeScript };
    resetBrowserControllerForTests();

    await expect(
      executeBrowserCommand({ action: 'page.context', tabId: 7 })
    ).resolves.toMatchObject({ text: 'Ready' });
    expect(chrome.tabs.get).toHaveBeenCalledTimes(2);
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

  test('manages P1 windows, tabs, tab groups, and zoom through typed actions', async () => {
    await expect(executeBrowserCommand({ action: 'windows.list' })).resolves.toEqual([
      expect.objectContaining({ id: 1, focused: true, state: 'normal' }),
    ]);
    await executeBrowserCommand({
      action: 'windows.update',
      windowId: 1,
      focused: true,
      state: 'maximized',
    });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, {
      focused: true,
      state: 'maximized',
    });
    await executeBrowserCommand({ action: 'windows.close', windowId: 1 });
    expect(chrome.windows.remove).toHaveBeenCalledWith(1);

    await expect(executeBrowserCommand({ action: 'tabs.get', tabId: 7 })).resolves.toMatchObject({
      id: 7,
      windowId: 1,
      url: 'https://example.com',
    });
    await executeBrowserCommand({ action: 'tabs.update', tabId: 7, pinned: true, muted: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { pinned: true, muted: true });
    await executeBrowserCommand({ action: 'tabs.move', tabId: 7, windowId: 9, index: 0 });
    expect(chrome.tabs.move).toHaveBeenCalledWith(7, { windowId: 9, index: 0 });
    await expect(
      executeBrowserCommand({ action: 'tabs.duplicate', tabId: 7 })
    ).resolves.toMatchObject({
      id: 107,
    });
    await expect(
      executeBrowserCommand({ action: 'tabs.discard', tabId: 7 })
    ).resolves.toMatchObject({
      id: 7,
      discarded: true,
    });

    await expect(executeBrowserCommand({ action: 'tabGroups.list' })).resolves.toEqual([
      expect.objectContaining({ id: 4, title: 'Research' }),
    ]);
    await executeBrowserCommand({
      action: 'tabGroups.add',
      groupId: 4,
      tabIds: [7, 12],
    });
    expect(chrome.tabs.group).toHaveBeenCalledWith({ groupId: 4, tabIds: [7, 12] });
    await executeBrowserCommand({
      action: 'tabGroups.create',
      tabIds: [7, 12],
      title: 'Reading',
      color: 'green',
      collapsed: true,
    });
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [7, 12] });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(4, {
      title: 'Reading',
      color: 'green',
      collapsed: true,
    });
    await executeBrowserCommand({ action: 'tabGroups.ungroup', tabIds: [7, 12] });
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([7, 12]);

    await expect(executeBrowserCommand({ action: 'zoom.get', tabId: 7 })).resolves.toEqual({
      tabId: 7,
      factor: 1,
    });
    await executeBrowserCommand({ action: 'zoom.set', tabId: 7, factor: 1.25 });
    expect(chrome.tabs.setZoom).toHaveBeenCalledWith(7, 1.25);
  });

  test('manages P1 downloads with optional permission and explicit deletion', async () => {
    await expect(
      executeBrowserCommand({ action: 'downloads.list', state: 'complete', limit: 50 })
    ).resolves.toEqual([expect.objectContaining({ downloadId: 'chrome:55', state: 'complete' })]);
    await executeBrowserCommand({ action: 'downloads.pause', downloadId: 'chrome:55' });
    await executeBrowserCommand({ action: 'downloads.resume', downloadId: 'chrome:55' });
    await executeBrowserCommand({ action: 'downloads.cancel', downloadId: 'chrome:55' });
    await executeBrowserCommand({ action: 'downloads.open', downloadId: 'chrome:55' });
    await executeBrowserCommand({ action: 'downloads.show', downloadId: 'chrome:55' });
    expect(chrome.downloads.pause).toHaveBeenCalledWith(55);
    expect(chrome.downloads.resume).toHaveBeenCalledWith(55);
    expect(chrome.downloads.cancel).toHaveBeenCalledWith(55);
    expect(chrome.downloads.open).toHaveBeenCalledWith(55);
    expect(chrome.downloads.show).toHaveBeenCalledWith(55);

    await executeBrowserCommand({
      action: 'downloads.remove',
      downloadId: 'chrome:55',
      mode: 'both',
      confirm: 'REMOVE_DOWNLOAD',
    });
    expect(chrome.downloads.removeFile).toHaveBeenCalledWith(55);
    expect(chrome.downloads.erase).toHaveBeenCalledWith({ id: 55 });

    permissionContains.mockResolvedValue(false);
    await expect(executeBrowserCommand({ action: 'downloads.list' })).rejects.toThrow(
      'Downloads permission is required'
    );
  });

  test('manages bounded history and recently closed sessions', async () => {
    await expect(
      executeBrowserCommand({ action: 'history.search', text: 'Example', maxResults: 20 })
    ).resolves.toEqual([expect.objectContaining({ url: 'https://example.com', visitCount: 2 })]);
    await expect(
      executeBrowserCommand({ action: 'history.getVisits', url: 'https://example.com' })
    ).resolves.toEqual([expect.objectContaining({ visitId: 'visit-1' })]);

    await executeBrowserCommand({
      action: 'history.remove',
      target: { type: 'url', url: 'https://example.com' },
      confirm: 'REMOVE_BROWSER_HISTORY',
    });
    expect(chrome.history.deleteUrl).toHaveBeenCalledWith({ url: 'https://example.com' });
    await executeBrowserCommand({
      action: 'history.remove',
      target: { type: 'range', startTime: 1_000, endTime: 2_000 },
      confirm: 'REMOVE_BROWSER_HISTORY',
    });
    expect(chrome.history.deleteRange).toHaveBeenCalledWith({ startTime: 1_000, endTime: 2_000 });
    await executeBrowserCommand({
      action: 'history.remove',
      target: { type: 'all' },
      confirm: 'REMOVE_BROWSER_HISTORY',
    });
    expect(chrome.history.deleteAll).toHaveBeenCalled();

    await expect(
      executeBrowserCommand({ action: 'sessions.recent', maxResults: 10 })
    ).resolves.toEqual([expect.objectContaining({ type: 'tab', sessionId: 'recent-tab' })]);
    await expect(
      executeBrowserCommand({ action: 'sessions.restore', sessionId: 'recent-tab' })
    ).resolves.toMatchObject({ type: 'tab', sessionId: 'recent-tab' });
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

  test('supports complete typed P0 page interactions', async () => {
    await executeBrowserCommand({ action: 'page.snapshot', tabId: 7, frameId: 'frame-1' });
    expect(calls).toContainEqual({
      method: 'Accessibility.getFullAXTree',
      params: { frameId: 'frame-1' },
    });

    await executeBrowserCommand({
      action: 'page.setChecked',
      tabId: 7,
      selector: '@e1',
      checked: true,
    });
    expect(calls).toContainEqual({
      method: 'Runtime.callFunctionOn',
      params: expect.objectContaining({
        functionDeclaration: expect.stringContaining('evReadCheckState'),
      }),
    });

    await expect(
      executeBrowserCommand({
        action: 'page.select',
        tabId: 7,
        selector: '@e1',
        values: ['ca'],
      })
    ).resolves.toMatchObject({ selectedValues: ['ca'] });

    await executeBrowserCommand({
      action: 'page.drag',
      tabId: 7,
      sourceSelector: '@e1',
      targetSelector: '@e1',
    });
    expect(calls).toContainEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 60, y: 40, button: 'left', buttons: 1 },
    });

    await executeBrowserCommand({ action: 'page.focus', tabId: 7, selector: '@e1' });
    expect(calls).toContainEqual({ method: 'DOM.focus', params: { backendNodeId: 44 } });

    await expect(
      executeBrowserCommand({ action: 'page.inspect', tabId: 7, selector: '@e1' })
    ).resolves.toMatchObject({
      tagName: 'input',
      role: 'textbox',
      value: 'Draft',
      attributes: { 'aria-label': 'Title' },
    });

    await executeBrowserCommand({
      action: 'page.dialog.respond',
      tabId: 7,
      accept: true,
      promptText: 'approved',
    });
    expect(calls).toContainEqual({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: true, promptText: 'approved' },
    });

    await executeBrowserCommand({
      action: 'page.pointer',
      tabId: 7,
      type: 'click',
      x: 25,
      y: 50,
      button: 'right',
      clickCount: 2,
    });
    expect(calls.slice(-4)).toEqual([
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 25, y: 50, button: 'right', clickCount: 1 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: 25, y: 50, button: 'right', clickCount: 1 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 25, y: 50, button: 'right', clickCount: 2 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: 25, y: 50, button: 'right', clickCount: 2 },
      },
    ]);
  });

  test('supports page history, rich scrolling, keyboard shortcuts, and event waits', async () => {
    await executeBrowserCommand({ action: 'page.history', tabId: 7, operation: 'back' });
    expect(calls).toContainEqual({
      method: 'Page.navigateToHistoryEntry',
      params: { entryId: 10 },
    });
    await executeBrowserCommand({ action: 'page.history', tabId: 7, operation: 'forward' });
    expect(calls).toContainEqual({
      method: 'Page.navigateToHistoryEntry',
      params: { entryId: 12 },
    });
    await executeBrowserCommand({ action: 'page.history', tabId: 7, operation: 'reload' });
    await executeBrowserCommand({ action: 'page.history', tabId: 7, operation: 'stop' });
    expect(calls).toContainEqual({ method: 'Page.reload', params: {} });
    expect(calls).toContainEqual({ method: 'Page.stopLoading', params: {} });

    await executeBrowserCommand({ action: 'page.press', tabId: 7, key: 'a', modifiers: ['Meta'] });
    expect(calls).toContainEqual({
      method: 'Input.dispatchKeyEvent',
      params: expect.objectContaining({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 }),
    });

    await executeBrowserCommand({
      action: 'page.scroll',
      tabId: 7,
      deltaX: 20,
      deltaY: 400,
    });
    expect(calls).toContainEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x: 0, y: 0, deltaX: 20, deltaY: 400 },
    });

    const popup = executeBrowserCommand({
      action: 'page.wait',
      tabId: 7,
      condition: 'popup',
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(tabCreatedListeners.size).toBe(1));
    tabCreatedListeners.forEach(listener =>
      listener({
        id: 22,
        openerTabId: 7,
        windowId: 1,
        active: true,
        index: 1,
        pinned: false,
        highlighted: true,
        incognito: false,
        selected: true,
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
      })
    );
    await expect(popup).resolves.toMatchObject({ tabId: 7, popupTabId: 22 });

    const download = executeBrowserCommand({
      action: 'page.wait',
      tabId: 7,
      condition: 'download',
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(downloadCreatedListeners.size).toBe(1));
    downloadCreatedListeners.forEach(listener =>
      listener({
        id: 56,
        url: 'https://example.com/file.zip',
        finalUrl: 'https://example.com/file.zip',
        filename: '',
        danger: 'safe',
        mime: '',
        startTime: new Date().toISOString(),
        endTime: undefined,
        estimatedEndTime: undefined,
        state: 'in_progress',
        paused: false,
        canResume: false,
        error: undefined,
        bytesReceived: 0,
        totalBytes: 0,
        fileSize: -1,
        exists: true,
        byExtensionId: undefined,
        byExtensionName: undefined,
        incognito: false,
        referrer: '',
      })
    );
    await expect(download).resolves.toMatchObject({ tabId: 7, downloadId: 'chrome:56' });
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

  test('dispatches the owned page URL for bounded subtitle extraction', async () => {
    await expect(
      executeBrowserCommand({
        action: 'page.subtitles',
        tabId: 7,
        operation: 'read',
        includeAutomatic: true,
        format: 'vtt',
        maxChars: 100_000,
        fallback: 'none',
      })
    ).resolves.toEqual({
      pageUrl: 'https://example.com',
      title: 'Example',
    });
  });

  test('reads Bilibili subtitles inside the owned logged-in tab', async () => {
    vi.mocked(chrome.tabs.get).mockResolvedValue({
      id: 7,
      windowId: 1,
      title: 'Bilibili Example',
      url: 'https://www.bilibili.com/video/BV1sx3T6ZEqy/',
    } as chrome.tabs.Tab);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: { cid: 40272530365, pages: [{ page: 1, cid: 40272530365 }] },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  {
                    lan: 'ai-zh',
                    ai_type: 1,
                    subtitle_url: '//aisubtitle.hdslb.com/example.json',
                  },
                ],
              },
            },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            body: [
              { from: 0, to: 1, content: '第一句' },
              { from: 1, to: 2, content: '第二句' },
            ],
          })
        )
      );
    const executeScript = vi.fn(
      async (details: {
        func: (...args: [string, string | undefined, boolean, number]) => Promise<unknown>;
        args: [string, string | undefined, boolean, number];
      }) => [{ frameId: 0, result: await details.func(...details.args) }]
    );
    (
      globalThis.chrome as unknown as { scripting: { executeScript: typeof executeScript } }
    ).scripting = { executeScript };
    resetBrowserControllerForTests();

    await expect(
      executeBrowserCommand({
        action: 'page.subtitles',
        tabId: 7,
        operation: 'read',
        language: 'ai-zh',
        includeAutomatic: true,
        format: 'vtt',
        maxChars: 100_000,
        fallback: 'none',
      })
    ).resolves.toEqual({
      pageUrl: 'https://www.bilibili.com/video/BV1sx3T6ZEqy/',
      title: 'Bilibili Example',
      inlineSubtitle: {
        language: 'ai-zh',
        text: '第一句\n第二句',
        truncated: false,
      },
    });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.bilibili.com/x/web-interface/view?bvid=BV1sx3T6ZEqy',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'https://aisubtitle.hdslb.com/example.json',
      expect.objectContaining({ credentials: 'omit' })
    );
  });

  test('includes a browser-observed audio URL only for approved local ASR', async () => {
    const executeScript = vi.fn(async () => [
      {
        frameId: 0,
        result: {
          mediaUrl: 'https://media.example.com/audio.m4a?signature=secret',
          userAgent: 'EV Test Browser',
        },
      },
    ]);
    (
      globalThis.chrome as unknown as { scripting: { executeScript: typeof executeScript } }
    ).scripting = { executeScript };
    resetBrowserControllerForTests();

    await expect(
      executeBrowserCommand({
        action: 'page.subtitles',
        tabId: 7,
        operation: 'read',
        includeAutomatic: true,
        format: 'vtt',
        maxChars: 100_000,
        fallback: 'local-asr',
        confirm: 'RUN_LOCAL_ASR',
      })
    ).resolves.toEqual({
      pageUrl: 'https://example.com',
      title: 'Example',
      mediaUrl: 'https://media.example.com/audio.m4a?signature=secret',
      userAgent: 'EV Test Browser',
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

  test('keeps browser-shell and bookmark actions available without CDP page control', async () => {
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
    expect(capabilities.actions).toContain('tabs.list');
    expect(capabilities.actions).not.toContain('page.navigate');
    await expect(executeBrowserCommand({ action: 'bookmarks.list' })).resolves.toMatchObject({
      nodes: expect.any(Array),
    });
    await expect(executeBrowserCommand({ action: 'tabs.list' })).resolves.toEqual([
      expect.objectContaining({ id: 7, windowId: 1 }),
    ]);
    await expect(executeBrowserCommand({ action: 'page.snapshot', tabId: 7 })).rejects.toThrow(
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
    expect(capabilities.actions).toContain('page.setChecked');
    expect(capabilities.actions).toContain('windows.list');
    expect(capabilities.actions).toContain('history.search');
    expect(capabilities.actions).toContain('page.webmcp.listTools');
    expect(capabilities.actions).toContain('page.webmcp.callTool');

    await executeBrowserCommand({ action: 'page.snapshot', tabId: 7 });
    await executeBrowserCommand({ action: 'page.release', tabId: 7 });
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 7 });
  });

  test('lists and calls page WebMCP tools through the content-script bridge', async () => {
    pageBridge.mockImplementation(async (_tabId: number, message: { type?: string }) => {
      if (message.type === 'ev-webmcp.listTools') {
        return { tools: [{ name: 'search_products', description: 'Search the catalog' }] };
      }
      if (message.type === 'ev-webmcp.callTool') {
        return { ok: true, result: { items: ['kb-1'] } };
      }
      return undefined;
    });

    await expect(
      executeBrowserCommand({ action: 'page.webmcp.listTools', tabId: 7 })
    ).resolves.toEqual({
      tabId: 7,
      tools: [{ name: 'search_products', description: 'Search the catalog' }],
    });
    await expect(
      executeBrowserCommand({
        action: 'page.webmcp.callTool',
        tabId: 7,
        name: 'search_products',
        args: { query: 'keyboard' },
        timeoutMs: 5_000,
      })
    ).resolves.toEqual({
      tabId: 7,
      name: 'search_products',
      ok: true,
      result: { items: ['kb-1'] },
    });
    expect(pageBridge).toHaveBeenCalledWith(7, {
      type: 'ev-webmcp.callTool',
      name: 'search_products',
      args: { query: 'keyboard' },
      timeoutMs: 5_000,
    });
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });

  test('wraps WebMCP bridge failures into JSON error envelopes', async () => {
    pageBridge.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.')
    );

    await expect(
      executeBrowserCommand({ action: 'page.webmcp.listTools', tabId: 7 })
    ).rejects.toThrow(/page bridge is unavailable/);
    await expect(
      executeBrowserCommand({ action: 'page.webmcp.callTool', tabId: 7, name: 'search_products' })
    ).resolves.toMatchObject({
      tabId: 7,
      name: 'search_products',
      ok: false,
      errorCode: 'bridge-unavailable',
    });
  });

  test('requests an action highlight before fixed DOM element operations when enabled', async () => {
    vi.mocked(chrome.storage.sync.get).mockResolvedValue({ actionHighlight: true } as never);
    const executeScript = vi.fn(async () => [
      { frameId: 0, result: { clicked: true, x: 10, y: 20 } },
    ]);
    (
      globalThis.chrome as unknown as { scripting: { executeScript: typeof executeScript } }
    ).scripting = { executeScript };
    resetBrowserControllerForTests();
    resetActionHighlightForTests();

    await executeBrowserCommand({ action: 'page.click', tabId: 7, selector: '#save' });

    expect(pageBridge).toHaveBeenCalledWith(7, {
      type: 'ev-action.highlight',
      selector: '#save',
      label: 'click',
    });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  test('skips action highlights when the setting is disabled and survives bridge failures', async () => {
    pageBridge.mockRejectedValue(new Error('bridge down'));
    const executeScript = vi.fn(async () => [
      { frameId: 0, result: { clicked: true, x: 10, y: 20 } },
    ]);
    (
      globalThis.chrome as unknown as { scripting: { executeScript: typeof executeScript } }
    ).scripting = { executeScript };
    resetBrowserControllerForTests();
    resetActionHighlightForTests();

    // Storage mock defaults to actionHighlight: false, so no request is made...
    await executeBrowserCommand({ action: 'page.click', tabId: 7, selector: '#save' });
    expect(pageBridge).not.toHaveBeenCalled();

    // ...and even with the switch enabled a failing bridge never breaks the action.
    vi.mocked(chrome.storage.sync.get).mockResolvedValue({ actionHighlight: true } as never);
    resetActionHighlightForTests();
    await expect(
      executeBrowserCommand({ action: 'page.click', tabId: 7, selector: '#save' })
    ).resolves.toMatchObject({ clicked: true });
    expect(pageBridge).toHaveBeenCalledTimes(1);
  });

  test('highlights CDP element actions through the shared renderer declaration', async () => {
    vi.mocked(chrome.storage.sync.get).mockResolvedValue({ actionHighlight: true } as never);
    resetActionHighlightForTests();

    await executeBrowserCommand({ action: 'page.snapshot', tabId: 7 });
    await executeBrowserCommand({ action: 'page.click', tabId: 7, selector: '@e1' });

    expect(calls).toContainEqual({
      method: 'Runtime.callFunctionOn',
      params: expect.objectContaining({
        functionDeclaration: expect.stringContaining('evActionHighlight'),
        arguments: [{ value: 'click' }],
      }),
    });
  });
});
