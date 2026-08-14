import type { BrowserAtomicCommand } from '@ev/contracts';
import { describe, expect, it, vi } from 'vitest';

import { BrowserSessionManager } from '../browser-session-manager';

interface FakeTab {
  id: number;
  windowId: number;
  active: boolean;
  title: string;
  url: string;
  cdpAttached: boolean;
}

function createFakeBrowser() {
  const tabs = new Map<number, FakeTab>([
    [
      42,
      {
        id: 42,
        windowId: 1,
        active: true,
        title: 'User tab',
        url: 'https://user.example.com',
        cdpAttached: false,
      },
    ],
  ]);
  let nextWindowId = 9;
  let nextTabId = 11;
  const closedTabIds: number[] = [];

  const execute = vi.fn(async (command: BrowserAtomicCommand): Promise<unknown> => {
    switch (command.action) {
      case 'windows.open': {
        const windowId = nextWindowId++;
        const tabId = nextTabId++;
        tabs.set(tabId, {
          id: tabId,
          windowId,
          active: true,
          title: '',
          url: command.url,
          cdpAttached: false,
        });
        return { windowId, tabId, url: command.url };
      }
      case 'tabs.open': {
        const tabId = nextTabId++;
        const windowId = command.windowId ?? 1;
        tabs.set(tabId, {
          id: tabId,
          windowId,
          active: command.active ?? true,
          title: '',
          url: command.url,
          cdpAttached: false,
        });
        return { id: tabId, windowId, url: command.url };
      }
      case 'tabs.list':
        return [...tabs.values()];
      case 'tabs.close':
        tabs.delete(command.tabId);
        closedTabIds.push(command.tabId);
        return { closed: true, tabId: command.tabId };
      default:
        return {
          action: command.action,
          tabId: 'tabId' in command ? command.tabId : undefined,
        };
    }
  });

  return { tabs, closedTabIds, execute };
}

const SESSION_ONE = '3f88e635-1ba1-4e8c-91fd-83d682959f8a';
const SESSION_TWO = '88b4763f-120d-4769-91bc-3802469c7775';

function sessionIds(): () => string {
  const ids = [SESSION_ONE, SESSION_TWO];
  return () => ids.shift() ?? '65aca994-a86f-45e4-8a29-997bf4425899';
}

describe('BrowserSessionManager', () => {
  it('owns created tabs, requires explicit adoption, and releases only owned tabs', async () => {
    const browser = createFakeBrowser();
    const manager = new BrowserSessionManager(browser.execute, sessionIds());

    await expect(
      manager.execute({ action: 'browser.session.create', url: 'https://example.com' })
    ).resolves.toEqual({
      sessionId: SESSION_ONE,
      windowId: 9,
      ownedTabIds: [11],
      borrowedTabIds: [],
      activeTabId: 11,
    });

    await expect(
      manager.execute({
        action: 'browser.session.open',
        sessionId: SESSION_ONE,
        url: 'https://example.com/docs',
        active: false,
      })
    ).resolves.toMatchObject({ ownedTabIds: [11, 12], activeTabId: 11 });

    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: { action: 'page.snapshot', tabId: 42 },
      })
    ).rejects.toThrow('does not own tab 42');

    await manager.execute({
      action: 'browser.session.adoptTab',
      sessionId: SESSION_ONE,
      tabId: 42,
    });
    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: { action: 'page.snapshot' },
      })
    ).resolves.toEqual({
      sessionId: SESSION_ONE,
      tabId: 42,
      result: { action: 'page.snapshot', tabId: 42 },
    });

    browser.tabs.set(99, {
      id: 99,
      windowId: 9,
      active: false,
      title: 'Unknown user tab',
      url: 'https://unknown.example.com',
      cdpAttached: false,
    });
    await expect(
      manager.execute({ action: 'browser.session.release', sessionId: SESSION_ONE })
    ).resolves.toEqual({
      sessionId: SESSION_ONE,
      released: true,
      closedOwnedTabIds: [11, 12],
      preservedBorrowedTabIds: [42],
    });

    expect(browser.closedTabIds).toEqual([11, 12]);
    expect(browser.tabs.has(42)).toBe(true);
    expect(browser.tabs.has(99)).toBe(true);
    await expect(manager.execute({ action: 'browser.session.list' })).resolves.toEqual({
      sessions: [],
    });
  });

  it('prevents two sessions from owning or borrowing the same tab', async () => {
    const browser = createFakeBrowser();
    const manager = new BrowserSessionManager(browser.execute, sessionIds());
    await manager.execute({ action: 'browser.session.create', url: 'https://one.example.com' });
    await manager.execute({ action: 'browser.session.create', url: 'https://two.example.com' });
    await manager.execute({
      action: 'browser.session.adoptTab',
      sessionId: SESSION_ONE,
      tabId: 42,
    });

    await expect(
      manager.execute({
        action: 'browser.session.adoptTab',
        sessionId: SESSION_TWO,
        tabId: 42,
      })
    ).rejects.toThrow(`Tab 42 already belongs to BrowserSession ${SESSION_ONE}`);
    await expect(
      manager.execute({
        action: 'browser.session.adoptTab',
        sessionId: SESSION_TWO,
        tabId: 11,
      })
    ).rejects.toThrow(`Tab 11 already belongs to BrowserSession ${SESSION_ONE}`);
  });

  it('scopes BrowserRun atomic commands to session tabs', async () => {
    const browser = createFakeBrowser();
    const manager = new BrowserSessionManager(browser.execute, sessionIds());
    await manager.execute({ action: 'browser.session.create', url: 'https://example.com' });

    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: {
          action: 'browser.run',
          steps: [
            {
              kind: 'command',
              command: { action: 'page.navigate', url: 'https://example.com/next' },
            },
          ],
        },
      })
    ).resolves.toMatchObject({
      sessionId: SESSION_ONE,
      tabId: 11,
      result: { status: 'completed', summary: { commands: 1 } },
    });

    expect(browser.execute).toHaveBeenCalledWith({
      action: 'page.navigate',
      tabId: 11,
      url: 'https://example.com/next',
    });
    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: {
          action: 'browser.run',
          tabId: 42,
          steps: [{ kind: 'wait', timeMs: 0 }],
        },
      })
    ).rejects.toThrow('does not own tab 42');
  });

  it('rejects session and tab limits before mutating Chrome', async () => {
    const sessionBrowser = createFakeBrowser();
    const sessionManager = new BrowserSessionManager(sessionBrowser.execute);
    for (let index = 0; index < 32; index += 1) {
      await sessionManager.execute({
        action: 'browser.session.create',
        url: `https://session-${index}.example.com`,
      });
    }
    await expect(
      sessionManager.execute({
        action: 'browser.session.create',
        url: 'https://overflow.example.com',
      })
    ).rejects.toThrow('cannot exceed 32 BrowserSessions');
    expect(
      sessionBrowser.execute.mock.calls.filter(([command]) => command.action === 'windows.open')
    ).toHaveLength(32);

    const tabBrowser = createFakeBrowser();
    const tabManager = new BrowserSessionManager(tabBrowser.execute, sessionIds());
    await tabManager.execute({ action: 'browser.session.create', url: 'https://example.com' });
    for (let index = 0; index < 31; index += 1) {
      await tabManager.execute({
        action: 'browser.session.open',
        sessionId: SESSION_ONE,
        url: `https://tab-${index}.example.com`,
        active: false,
      });
    }
    await expect(
      tabManager.execute({
        action: 'browser.session.open',
        sessionId: SESSION_ONE,
        url: 'https://overflow.example.com',
      })
    ).rejects.toThrow('cannot exceed 32 tabs');
    expect(
      tabBrowser.execute.mock.calls.filter(([command]) => command.action === 'tabs.open')
    ).toHaveLength(31);
  });

  it('keeps a multi-command exclusive operation contiguous within one session', async () => {
    const browser = createFakeBrowser();
    const manager = new BrowserSessionManager(browser.execute, sessionIds());
    await manager.execute({ action: 'browser.session.create', url: 'https://one.example.com' });

    let markReady!: () => void;
    const ready = new Promise<void>(resolve => (markReady = resolve));
    let releaseExclusive!: () => void;
    const hold = new Promise<void>(resolve => (releaseExclusive = resolve));
    const exclusive = manager.runExclusive(SESSION_ONE, async execute => {
      await execute({ action: 'page.context', maxChars: 1 });
      markReady();
      await hold;
      await execute({ action: 'page.snapshot', mode: 'interactive' });
    });
    await ready;

    const queued = manager.execute({
      action: 'browser.session.command',
      sessionId: SESSION_ONE,
      command: { action: 'page.press', key: 'Enter' },
    });
    await Promise.resolve();
    expect(
      browser.execute.mock.calls
        .map(([command]) => command.action)
        .filter(action => action.startsWith('page.'))
    ).toEqual(['page.context']);

    releaseExclusive();
    await Promise.all([exclusive, queued]);
    expect(
      browser.execute.mock.calls
        .map(([command]) => command.action)
        .filter(action => action.startsWith('page.'))
    ).toEqual(['page.context', 'page.snapshot', 'page.press']);
  });

  it('serializes one session while allowing separate sessions to progress concurrently', async () => {
    const browser = createFakeBrowser();
    const manager = new BrowserSessionManager(browser.execute, sessionIds());
    await manager.execute({ action: 'browser.session.create', url: 'https://one.example.com' });
    await manager.execute({ action: 'browser.session.create', url: 'https://two.example.com' });

    const originalExecute = browser.execute.getMockImplementation()!;
    const started: number[] = [];
    const releases: Array<() => void> = [];
    browser.execute.mockImplementation(async command => {
      if (command.action !== 'page.wait') return originalExecute(command);
      started.push(command.tabId!);
      await new Promise<void>(resolve => releases.push(resolve));
      return { tabId: command.tabId };
    });

    const first = manager.execute({
      action: 'browser.session.command',
      sessionId: SESSION_ONE,
      command: { action: 'page.wait', timeMs: 1 },
    });
    const queued = manager.execute({
      action: 'browser.session.command',
      sessionId: SESSION_ONE,
      command: { action: 'page.wait', timeMs: 1 },
    });
    const concurrent = manager.execute({
      action: 'browser.session.command',
      sessionId: SESSION_TWO,
      command: { action: 'page.wait', timeMs: 1 },
    });

    await vi.waitFor(() => expect(started).toEqual([11, 12]));
    expect(releases).toHaveLength(2);
    releases.splice(0).forEach(release => release());
    await Promise.all([first, concurrent]);

    await vi.waitFor(() => expect(started).toEqual([11, 12, 11]));
    releases.splice(0).forEach(release => release());
    await queued;
  });
});
