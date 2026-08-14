import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserCommandExecutor } from '../browser-command-executor';
import type { BrowserBridgeService } from '../browser-bridge-service';
import type { MediaDownloadService } from '../media-download-service';

describe('BrowserCommandExecutor', () => {
  it('normalizes Chrome download IDs and routes local status without using the bridge', async () => {
    const bridge = {
      sendCommand: vi.fn(async () => ({ backend: 'chrome', downloadId: 42 })),
    } as unknown as BrowserBridgeService;
    const downloads = {
      start: vi.fn(),
      status: vi.fn(() => ({
        downloadId: 'local:job',
        backend: 'local',
        state: 'complete',
        filename: '/tmp/EV/video.mp4',
      })),
    } as unknown as MediaDownloadService;
    const executor = new BrowserCommandExecutor(bridge, downloads);

    await expect(
      executor.sendCommand({ action: 'page.download', tabId: 7, ref: '@m1' })
    ).resolves.toEqual({
      downloadId: 'chrome:42',
      backend: 'chrome',
      state: 'in_progress',
    });
    await expect(
      executor.sendCommand({ action: 'downloads.status', downloadId: 'local:job' })
    ).resolves.toMatchObject({ state: 'complete' });
    expect(bridge.sendCommand).toHaveBeenCalledOnce();
  });

  it('executes bounded BrowserRun loops locally and returns only a summary', async () => {
    const bridge = {
      sendCommand: vi.fn(async (command: { action: string }) => {
        if (command.action === 'page.snapshot') {
          return {
            nodes: [
              { ref: '@e1', role: 'link', name: '添加隐藏的字词或短语' },
              { ref: '@e2', role: 'textbox', name: '输入字词或短语' },
              { ref: '@e3', role: 'button', name: '保存' },
            ],
          };
        }
        return { ok: true };
      }),
    } as unknown as BrowserBridgeService;
    const executor = new BrowserCommandExecutor(bridge, {} as MediaDownloadService);

    const result = await executor.sendCommand({
      action: 'browser.run',
      tabId: 7,
      steps: [
        {
          kind: 'forEach',
          id: 'add-words',
          items: ['福不黑', '寻固炮'],
          onError: 'continue',
          steps: [
            {
              kind: 'command',
              command: {
                action: 'page.click',
                target: { role: 'link', name: '添加隐藏的字词或短语' },
              },
            },
            {
              kind: 'command',
              command: {
                action: 'page.type',
                target: { role: 'textbox', name: '输入字词或短语' },
                text: { from: 'item' },
                clearFirst: true,
              },
            },
            {
              kind: 'command',
              command: {
                action: 'page.click',
                target: { role: 'button', name: '保存' },
              },
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      status: 'completed',
      summary: { commands: 6, iterations: 2, retries: 0 },
      failures: [],
    });
    expect(result).not.toHaveProperty('nodes');
    const sentCommands = vi.mocked(bridge.sendCommand).mock.calls.map(([command]) => command);
    expect(sentCommands).not.toContainEqual(expect.objectContaining({ action: 'browser.run' }));
    expect(
      sentCommands
        .filter(command => command.action === 'page.type')
        .map(command => ('text' in command ? command.text : undefined))
    ).toEqual(['福不黑', '寻固炮']);
  });

  it('re-resolves semantic targets on retry and continues failed loop items', async () => {
    let badAttempts = 0;
    const bridge = {
      sendCommand: vi.fn(async (command: { action: string; text?: string }) => {
        if (command.action === 'page.snapshot') {
          return { nodes: [{ ref: `@e${badAttempts + 1}`, role: 'textbox', name: '词语' }] };
        }
        if (command.action === 'page.type' && command.text === 'bad') {
          badAttempts += 1;
          throw new Error('stale target');
        }
        return { ok: true };
      }),
    } as unknown as BrowserBridgeService;
    const executor = new BrowserCommandExecutor(bridge, {} as MediaDownloadService);

    const result = await executor.sendCommand({
      action: 'browser.run',
      tabId: 7,
      steps: [
        {
          kind: 'forEach',
          id: 'items',
          items: ['bad', 'good'],
          onError: 'continue',
          steps: [
            {
              kind: 'command',
              command: {
                action: 'page.type',
                target: { role: 'textbox', name: '词语' },
                text: { from: 'item' },
              },
              retry: { attempts: 2, delayMs: 0 },
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      status: 'partial',
      summary: { commands: 3, iterations: 2, retries: 1 },
      failures: [{ stepId: 'items', itemIndex: 0, item: 'bad', message: 'stale target' }],
    });
    expect(badAttempts).toBe(2);
    expect(bridge.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'page.type', text: 'good' })
    );
  });

  it('keeps BrowserSession commands inside Browser Host', async () => {
    const bridge = {
      sendCommand: vi.fn(async (command: { action: string }) => {
        if (command.action === 'windows.open') {
          return { windowId: 9, tabId: 11, url: 'https://example.com' };
        }
        return [];
      }),
    } as unknown as BrowserBridgeService;
    const executor = new BrowserCommandExecutor(bridge, {} as MediaDownloadService);

    await expect(
      executor.sendCommand({ action: 'browser.session.create', url: 'https://example.com' })
    ).resolves.toMatchObject({ windowId: 9, ownedTabIds: [11], borrowedTabIds: [] });
    expect(bridge.sendCommand).toHaveBeenCalledWith({
      action: 'windows.open',
      url: 'https://example.com',
      focused: false,
    });
    expect(vi.mocked(bridge.sendCommand).mock.calls.map(([command]) => command)).not.toContainEqual(
      expect.objectContaining({ action: 'browser.session.create' })
    );
  });

  it('keeps SiteRecipe commands inside Browser Host', async () => {
    const bridge = { sendCommand: vi.fn(async () => undefined) } as unknown as BrowserBridgeService;
    const recipeFilePath = path.join(os.tmpdir(), `ev-recipes-${randomUUID()}.json`);
    const executor = new BrowserCommandExecutor(bridge, {} as MediaDownloadService, recipeFilePath);

    await expect(executor.sendCommand({ action: 'browser.recipe.list' })).resolves.toMatchObject({
      recipes: [
        { id: 'x.mute-words', status: 'approved' },
        { id: 'x.read-grok-conversation', status: 'approved' },
      ],
    });
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('runs SiteRecipes through live BrowserSession ownership', async () => {
    const liveTabs = [
      {
        id: 11,
        windowId: 9,
        active: true,
        title: 'Grok',
        url: 'https://x.com/i/grok/share/abc',
        cdpAttached: false,
      },
    ];
    const bridge = {
      sendCommand: vi.fn(async (command: { action: string }) => {
        if (command.action === 'windows.open') {
          return { windowId: 9, tabId: 11, url: 'https://x.com/i/grok/share/abc' };
        }
        if (command.action === 'tabs.list') return liveTabs;
        if (command.action === 'page.context') {
          return {
            url: 'https://x.com/i/grok/share/abc',
            title: 'Grok',
            text: 'conversation',
            capturedAt: '2026-08-11T00:00:00.000Z',
          };
        }
        throw new Error(`unexpected action ${command.action}`);
      }),
    } as unknown as BrowserBridgeService;
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
    expect(vi.mocked(bridge.sendCommand).mock.calls.map(([command]) => command)).not.toContainEqual(
      expect.objectContaining({ action: 'browser.recipe.run' })
    );
  });

  it('advertises Host capabilities only when CDP supports them', async () => {
    const bridge = {
      sendCommand: vi.fn(async () => ({
        actions: ['tabs.list', 'windows.open', 'page.navigate'],
      })),
    } as unknown as BrowserBridgeService;
    const executor = new BrowserCommandExecutor(bridge, {} as MediaDownloadService);

    await expect(executor.sendCommand({ action: 'browser.capabilities' })).resolves.toEqual({
      actions: [
        'tabs.list',
        'windows.open',
        'page.navigate',
        'browser.run',
        'browser.session.create',
        'browser.session.list',
        'browser.session.get',
        'browser.session.open',
        'browser.session.adoptTab',
        'browser.session.command',
        'browser.session.release',
        'browser.recipe.list',
        'browser.recipe.get',
        'browser.recipe.draft.save',
        'browser.recipe.approve',
        'browser.recipe.run',
      ],
    });

    vi.mocked(bridge.sendCommand).mockResolvedValueOnce({ actions: ['bookmarks.list'] });
    await expect(executor.sendCommand({ action: 'browser.capabilities' })).resolves.toEqual({
      actions: ['bookmarks.list'],
    });
  });

  it('starts a local helper job for streaming media', async () => {
    const dispatch = {
      backend: 'external' as const,
      mediaKind: 'stream' as const,
      pageUrl: 'https://example.com/watch',
      url: 'https://cdn.example.com/master.m3u8',
    };
    const bridge = {
      sendCommand: vi.fn(async () => dispatch),
    } as unknown as BrowserBridgeService;
    const downloads = {
      start: vi.fn(async () => ({
        downloadId: 'local:job',
        backend: 'local',
        state: 'in_progress',
      })),
    } as unknown as MediaDownloadService;
    const executor = new BrowserCommandExecutor(bridge, downloads);

    await expect(
      executor.sendCommand({ action: 'page.download', tabId: 7, ref: '@m2' })
    ).resolves.toMatchObject({ downloadId: 'local:job', state: 'in_progress' });
    expect(downloads.start).toHaveBeenCalledWith(dispatch);
  });
});
