import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { BrowserAtomicCommand } from '@ev/contracts';
import { describe, expect, it, vi } from 'vitest';

import { BrowserCommandExecutor } from '../browser-command-executor';
import type { BrowserBridgeService } from '../browser-bridge-service';
import type { MediaDownloadService } from '../media-download-service';

type CommandHandler = (command: BrowserAtomicCommand) => Promise<unknown> | unknown;

function createIsolatedBridge(handler: CommandHandler = () => ({ ok: true })) {
  let live = false;
  const tab = {
    id: 11,
    windowId: 9,
    groupId: 20,
    active: true,
    title: 'EV',
    url: 'https://example.com',
    cdpAttached: false,
  };
  const group = {
    id: 20,
    windowId: 9,
    title: 'EV',
    color: 'cyan',
    collapsed: false,
  };
  const sendCommand = vi.fn(async (command: BrowserAtomicCommand): Promise<unknown> => {
    switch (command.action) {
      case 'windows.open':
        live = true;
        tab.url = command.url;
        return { windowId: 9, tabId: 11, url: command.url };
      case 'tabGroups.create':
      case 'tabGroups.add':
        return group;
      case 'tabs.list':
        return live ? [tab] : [];
      case 'tabs.get':
        return tab;
      case 'tabs.close':
        live = false;
        return { closed: true, tabId: command.tabId };
      default:
        return handler(command);
    }
  });
  return {
    bridge: { sendCommand } as unknown as BrowserBridgeService,
    sendCommand,
    isLive: () => live,
  };
}

async function createSession(executor: BrowserCommandExecutor): Promise<string> {
  const session = (await executor.sendCommand({
    action: 'browser.session.create',
    url: 'https://example.com',
  })) as { sessionId: string };
  return session.sessionId;
}

describe('BrowserCommandExecutor', () => {
  it('rejects direct workspace actions and allows explicit profile-global actions', async () => {
    const { bridge, sendCommand } = createIsolatedBridge(command => {
      if (command.action === 'downloads.list') return [];
      return { ok: true };
    });
    const executor = new BrowserCommandExecutor(bridge, {} as MediaDownloadService);

    await expect(executor.sendCommand({ action: 'page.snapshot' })).rejects.toThrow(
      'require browser.session.command or browser.oneShot'
    );
    await expect(executor.sendCommand({ action: 'tabs.list' })).rejects.toThrow(
      'require browser.session.command or browser.oneShot'
    );
    await expect(executor.sendCommand({ action: 'sessions.restore' })).rejects.toThrow(
      'require browser.session.command or browser.oneShot'
    );
    await expect(executor.sendCommand({ action: 'downloads.list' })).resolves.toEqual([]);
    expect(sendCommand).toHaveBeenCalledOnce();
  });

  it('creates, groups, executes, and releases a one-shot browser window', async () => {
    const { bridge, sendCommand, isLive } = createIsolatedBridge(command => {
      if (command.action === 'page.snapshot') return { tabId: command.tabId, nodes: [] };
      return { ok: true };
    });
    const executor = new BrowserCommandExecutor(bridge, {} as MediaDownloadService);

    await expect(
      executor.sendCommand({
        action: 'browser.oneShot',
        url: 'https://example.com',
        command: { action: 'page.snapshot', mode: 'interactive' },
      })
    ).resolves.toMatchObject({ tabId: 11, result: { tabId: 11, nodes: [] } });
    expect(isLive()).toBe(false);
    expect(sendCommand).toHaveBeenCalledWith({
      action: 'tabGroups.create',
      tabIds: [11],
      windowId: 9,
      title: 'EV',
      color: 'cyan',
      collapsed: false,
    });
    expect(sendCommand).toHaveBeenCalledWith({ action: 'tabs.close', tabId: 11 });
  });

  it('normalizes Chrome and local media downloads inside a BrowserSession', async () => {
    const chromeBridge = createIsolatedBridge(command => {
      if (command.action === 'page.download') return { backend: 'chrome', downloadId: 42 };
      return { ok: true };
    });
    const localDownloads = {
      status: vi.fn(() => ({
        downloadId: 'local:job',
        backend: 'local',
        state: 'complete',
        filename: '/tmp/EV/video.mp4',
      })),
    } as unknown as MediaDownloadService;
    const executor = new BrowserCommandExecutor(chromeBridge.bridge, localDownloads);
    const sessionId = await createSession(executor);

    await expect(
      executor.sendCommand({
        action: 'browser.session.command',
        sessionId,
        command: { action: 'page.download', ref: '@m1' },
      })
    ).resolves.toMatchObject({
      tabId: 11,
      result: { downloadId: 'chrome:42', backend: 'chrome', state: 'in_progress' },
    });
    await expect(
      executor.sendCommand({ action: 'downloads.status', downloadId: 'local:job' })
    ).resolves.toMatchObject({ state: 'complete' });
  });

  it('executes bounded BrowserRun loops only inside a BrowserSession', async () => {
    const { bridge, sendCommand } = createIsolatedBridge(command => {
      if (command.action === 'page.snapshot') {
        return {
          nodes: [
            { ref: '@e1', role: 'link', name: 'Add word' },
            { ref: '@e2', role: 'textbox', name: 'Word' },
          ],
        };
      }
      return { ok: true };
    });
    const executor = new BrowserCommandExecutor(bridge, {} as MediaDownloadService);
    const sessionId = await createSession(executor);

    const response = (await executor.sendCommand({
      action: 'browser.session.command',
      sessionId,
      command: {
        action: 'browser.run',
        steps: [
          {
            kind: 'forEach',
            items: ['first', 'second'],
            onError: 'continue',
            steps: [
              {
                kind: 'command',
                command: {
                  action: 'page.click',
                  target: { role: 'link', name: 'Add word' },
                },
              },
              {
                kind: 'command',
                command: {
                  action: 'page.type',
                  target: { role: 'textbox', name: 'Word' },
                  text: { from: 'item' },
                },
              },
            ],
          },
        ],
      },
    })) as { result: Record<string, unknown> };

    expect(response.result).toMatchObject({
      status: 'completed',
      summary: { commands: 4, iterations: 2, retries: 0 },
      failures: [],
    });
    expect(
      sendCommand.mock.calls
        .map(([command]) => command)
        .filter(command => command.action === 'page.type')
        .map(command => ('text' in command ? command.text : undefined))
    ).toEqual(['first', 'second']);
  });

  it('keeps SiteRecipes inside the dedicated session group', async () => {
    const { bridge, sendCommand } = createIsolatedBridge(command => {
      if (command.action === 'page.context') {
        return {
          url: 'https://x.com/i/grok/share/abc',
          title: 'Grok',
          text: 'conversation',
          capturedAt: '2026-08-11T00:00:00.000Z',
        };
      }
      return { ok: true };
    });
    const executor = new BrowserCommandExecutor(
      bridge,
      {} as MediaDownloadService,
      path.join(os.tmpdir(), `ev-recipes-${randomUUID()}.json`)
    );
    const session = (await executor.sendCommand({
      action: 'browser.session.create',
      url: 'https://x.com/i/grok/share/abc',
    })) as { sessionId: string };

    await expect(
      executor.sendCommand({
        action: 'browser.recipe.run',
        recipeId: 'x.read-grok-conversation',
        sessionId: session.sessionId,
        input: { kind: 'x.read-grok-conversation', maxChars: 50_000 },
      })
    ).resolves.toMatchObject({
      recipeId: 'x.read-grok-conversation',
      status: 'completed',
      output: { text: 'conversation' },
    });
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'page.context', tabId: 11 })
    );
  });

  it('advertises only isolated top-level actions and scoped session actions', async () => {
    const extensionActions = [
      'browser.capabilities',
      'windows.open',
      'windows.list',
      'tabs.open',
      'tabs.list',
      'tabs.close',
      'tabGroups.create',
      'tabGroups.add',
      'tabGroups.list',
      'page.navigate',
      'page.snapshot',
      'bookmarks.list',
      'downloads.list',
      'sessions.recent',
      'sessions.restore',
    ];
    const bridge = {
      sendCommand: vi.fn(async () => ({ actions: extensionActions })),
    } as unknown as BrowserBridgeService;
    const executor = new BrowserCommandExecutor(bridge, {} as MediaDownloadService);

    await expect(executor.sendCommand({ action: 'browser.capabilities' })).resolves.toEqual({
      actions: [
        'browser.capabilities',
        'bookmarks.list',
        'downloads.list',
        'sessions.recent',
        'browser.oneShot',
        'browser.session.create',
        'browser.session.list',
        'browser.session.get',
        'browser.session.open',
        'browser.session.command',
        'browser.session.release',
        'browser.recipe.list',
        'browser.recipe.get',
        'browser.recipe.draft.save',
        'browser.recipe.approve',
        'browser.recipe.run',
      ],
      sessionActions: [
        'windows.list',
        'tabs.list',
        'tabs.close',
        'tabGroups.list',
        'page.navigate',
        'page.snapshot',
        'browser.run',
      ],
    });
  });

  it('reads and downloads subtitles through the bounded local helper', async () => {
    const dispatch = { pageUrl: 'https://example.com/watch', title: 'Example' };
    const { bridge } = createIsolatedBridge(command => {
      if (command.action === 'page.subtitles') return dispatch;
      return { ok: true };
    });
    const downloads = {
      readSubtitles: vi.fn(async () => ({
        ...dispatch,
        language: 'en',
        format: 'vtt',
        text: 'Hello',
        truncated: false,
      })),
      downloadSubtitles: vi.fn(async () => ({
        ...dispatch,
        language: 'en',
        format: 'srt',
        filename: '/tmp/EV/example.en.srt',
      })),
    } as unknown as MediaDownloadService;
    const executor = new BrowserCommandExecutor(bridge, downloads);
    const sessionId = await createSession(executor);

    await expect(
      executor.sendCommand({
        action: 'browser.session.command',
        sessionId,
        command: {
          action: 'page.subtitles',
          operation: 'read',
          language: 'en',
          includeAutomatic: true,
          format: 'vtt',
          maxChars: 100_000,
          fallback: 'none',
        },
      })
    ).resolves.toMatchObject({ result: { text: 'Hello', language: 'en' } });
    expect(downloads.readSubtitles).toHaveBeenCalledWith({
      ...dispatch,
      language: 'en',
      includeAutomatic: true,
      format: 'vtt',
      maxChars: 100_000,
      fallback: 'none',
    });

    await expect(
      executor.sendCommand({
        action: 'browser.session.command',
        sessionId,
        command: {
          action: 'page.subtitles',
          operation: 'download',
          language: 'en',
          includeAutomatic: false,
          format: 'srt',
          maxChars: 100_000,
          fallback: 'none',
        },
      })
    ).resolves.toMatchObject({ result: { filename: '/tmp/EV/example.en.srt' } });
  });

  it('starts a local helper job for streaming media inside a BrowserSession', async () => {
    const dispatch = {
      backend: 'external' as const,
      mediaKind: 'stream' as const,
      pageUrl: 'https://example.com/watch',
      url: 'https://cdn.example.com/master.m3u8',
    };
    const { bridge } = createIsolatedBridge(command => {
      if (command.action === 'page.download') return dispatch;
      return { ok: true };
    });
    const downloads = {
      start: vi.fn(async () => ({
        downloadId: 'local:job',
        backend: 'local',
        state: 'in_progress',
      })),
    } as unknown as MediaDownloadService;
    const executor = new BrowserCommandExecutor(bridge, downloads);
    const sessionId = await createSession(executor);

    await expect(
      executor.sendCommand({
        action: 'browser.session.command',
        sessionId,
        command: { action: 'page.download', ref: '@m2' },
      })
    ).resolves.toMatchObject({ result: { downloadId: 'local:job', state: 'in_progress' } });
    expect(downloads.start).toHaveBeenCalledWith(dispatch);
  });
});
