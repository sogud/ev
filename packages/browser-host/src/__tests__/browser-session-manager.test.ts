import type { BrowserAtomicCommand } from '@ev/contracts';
import { describe, expect, it, vi } from 'vitest';

import { BrowserSessionManager } from '../browser-session-manager';

interface FakeTab {
  id: number;
  windowId: number;
  groupId: number;
  active: boolean;
  title: string;
  url: string;
  cdpAttached: boolean;
}

interface FakeGroup {
  id: number;
  windowId: number;
  title: string;
  color: 'cyan';
  collapsed: boolean;
}

function createFakeBrowser() {
  const tabs = new Map<number, FakeTab>([
    [
      42,
      {
        id: 42,
        windowId: 1,
        groupId: -1,
        active: true,
        title: 'User tab',
        url: 'https://user.example.com',
        cdpAttached: false,
      },
    ],
  ]);
  const groups = new Map<number, FakeGroup>();
  let nextWindowId = 9;
  let nextTabId = 11;
  let nextGroupId = 20;
  const closedTabIds: number[] = [];

  const execute = vi.fn(async (command: BrowserAtomicCommand): Promise<unknown> => {
    switch (command.action) {
      case 'windows.open': {
        const windowId = nextWindowId++;
        const tabId = nextTabId++;
        tabs.set(tabId, {
          id: tabId,
          windowId,
          groupId: -1,
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
          groupId: -1,
          active: command.active ?? true,
          title: '',
          url: command.url,
          cdpAttached: false,
        });
        return { id: tabId, windowId, url: command.url };
      }
      case 'tabs.list':
        return [...tabs.values()];
      case 'tabs.get':
        return tabs.get(command.tabId);
      case 'tabs.update': {
        const tab = tabs.get(command.tabId);
        if (!tab) throw new Error(`Tab ${command.tabId} not found`);
        if (command.url !== undefined) tab.url = command.url;
        if (command.active !== undefined) tab.active = command.active;
        return { ...tab };
      }
      case 'tabs.move': {
        const tab = tabs.get(command.tabId);
        if (!tab) throw new Error(`Tab ${command.tabId} not found`);
        if (command.windowId !== undefined) tab.windowId = command.windowId;
        tab.groupId = -1;
        return { ...tab };
      }
      case 'tabs.duplicate': {
        const source = tabs.get(command.tabId);
        if (!source) throw new Error(`Tab ${command.tabId} not found`);
        const tab = { ...source, id: nextTabId++, groupId: -1 };
        tabs.set(tab.id, tab);
        return tab;
      }
      case 'tabs.close':
        tabs.delete(command.tabId);
        closedTabIds.push(command.tabId);
        return { closed: true, tabId: command.tabId };
      case 'tabGroups.create': {
        const group: FakeGroup = {
          id: nextGroupId++,
          windowId: command.windowId ?? tabs.get(command.tabIds[0])?.windowId ?? 1,
          title: command.title ?? '',
          color: 'cyan',
          collapsed: command.collapsed ?? false,
        };
        groups.set(group.id, group);
        for (const tabId of command.tabIds) {
          const tab = tabs.get(tabId);
          if (tab) {
            tab.windowId = group.windowId;
            tab.groupId = group.id;
          }
        }
        return group;
      }
      case 'tabGroups.add': {
        const group = groups.get(command.groupId);
        if (!group) throw new Error(`Group ${command.groupId} not found`);
        for (const tabId of command.tabIds) {
          const tab = tabs.get(tabId);
          if (tab) {
            tab.windowId = group.windowId;
            tab.groupId = group.id;
          }
        }
        return group;
      }
      case 'tabGroups.list':
        return [...groups.values()].filter(
          group => command.windowId === undefined || group.windowId === command.windowId
        );
      case 'tabGroups.update': {
        const group = groups.get(command.groupId);
        if (!group) throw new Error(`Group ${command.groupId} not found`);
        if (command.title !== undefined) group.title = command.title;
        if (command.collapsed !== undefined) group.collapsed = command.collapsed;
        return group;
      }
      case 'windows.list':
        return [...new Set([...tabs.values()].map(tab => tab.windowId))].map(id => ({ id }));
      default:
        return {
          action: command.action,
          tabId: 'tabId' in command ? command.tabId : undefined,
        };
    }
  });

  return { tabs, groups, closedTabIds, execute };
}

const SESSION_ONE = '3f88e635-1ba1-4e8c-91fd-83d682959f8a';
const SESSION_TWO = '88b4763f-120d-4769-91bc-3802469c7775';

function sessionIds(): () => string {
  const ids = [SESSION_ONE, SESSION_TWO];
  return () => ids.shift() ?? '65aca994-a86f-45e4-8a29-997bf4425899';
}

describe('BrowserSessionManager', () => {
  it('creates a dedicated window and group, then releases only EV-owned tabs', async () => {
    const browser = createFakeBrowser();
    const manager = new BrowserSessionManager(browser.execute, sessionIds());

    await expect(
      manager.execute({ action: 'browser.session.create', url: 'https://example.com' })
    ).resolves.toEqual({
      sessionId: SESSION_ONE,
      windowId: 9,
      groupId: 20,
      ownedTabIds: [11],
      activeTabId: 11,
    });

    await expect(
      manager.execute({
        action: 'browser.session.open',
        sessionId: SESSION_ONE,
        url: 'https://example.com/docs',
        active: false,
      })
    ).resolves.toMatchObject({ groupId: 20, ownedTabIds: [11, 12], activeTabId: 11 });
    expect(browser.tabs.get(11)).toMatchObject({ windowId: 9, groupId: 20 });
    expect(browser.tabs.get(12)).toMatchObject({ windowId: 9, groupId: 20 });

    browser.tabs.set(99, {
      id: 99,
      windowId: 9,
      groupId: -1,
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
    });

    expect(browser.closedTabIds).toEqual([11, 12]);
    expect(browser.tabs.has(42)).toBe(true);
    expect(browser.tabs.has(99)).toBe(true);
  });

  it('rejects user tabs and restores moved EV tabs to their session group', async () => {
    const browser = createFakeBrowser();
    const manager = new BrowserSessionManager(browser.execute, sessionIds());
    await manager.execute({ action: 'browser.session.create', url: 'https://example.com' });

    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: { action: 'page.snapshot', tabId: 42 },
      })
    ).rejects.toThrow('does not own tab 42');

    Object.assign(browser.tabs.get(11)!, { windowId: 1, groupId: -1 });
    await manager.execute({ action: 'browser.session.get', sessionId: SESSION_ONE });
    expect(browser.tabs.get(11)).toMatchObject({ windowId: 9, groupId: 20 });
    expect(browser.execute).toHaveBeenCalledWith({
      action: 'tabGroups.add',
      groupId: 20,
      tabIds: [11],
    });
  });

  it('scopes workspace commands and preserves the one-group invariant', async () => {
    const browser = createFakeBrowser();
    const manager = new BrowserSessionManager(browser.execute, sessionIds());
    await manager.execute({ action: 'browser.session.create', url: 'https://example.com' });

    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: { action: 'tabs.list' },
      })
    ).resolves.toMatchObject({ result: [{ id: 11, groupId: 20 }] });
    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: { action: 'tabs.update', tabId: 11, pinned: true },
      })
    ).rejects.toThrow('cannot be pinned');
    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: { action: 'tabGroups.update', groupId: 999, title: 'Other' },
      })
    ).rejects.toThrow('does not own group 999');

    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: { action: 'tabs.duplicate', tabId: 11 },
      })
    ).resolves.toMatchObject({ result: { id: 12, windowId: 9, groupId: 20 } });
    await manager.execute({
      action: 'browser.session.command',
      sessionId: SESSION_ONE,
      command: { action: 'tabs.close', tabId: 12 },
    });
    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: { action: 'tabs.close', tabId: 11 },
      })
    ).rejects.toThrow('Release the BrowserSession');
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
  });

  it('routes WebMCP page commands through the session to owned tabs only', async () => {
    const browser = createFakeBrowser();
    const manager = new BrowserSessionManager(browser.execute, sessionIds());
    await manager.execute({ action: 'browser.session.create', url: 'https://example.com' });

    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: { action: 'page.webmcp.listTools' },
      })
    ).resolves.toMatchObject({ sessionId: SESSION_ONE, tabId: 11 });
    expect(browser.execute).toHaveBeenCalledWith({ action: 'page.webmcp.listTools', tabId: 11 });

    await expect(
      manager.execute({
        action: 'browser.session.command',
        sessionId: SESSION_ONE,
        command: { action: 'page.webmcp.callTool', name: 'search_products', tabId: 42 },
      })
    ).rejects.toThrow(/does not own tab 42/);
  });

  it('creates and releases a one-shot session around one scoped command', async () => {
    const browser = createFakeBrowser();
    const manager = new BrowserSessionManager(browser.execute, sessionIds());

    await expect(
      manager.runOneShot({
        action: 'browser.oneShot',
        url: 'https://example.com',
        command: { action: 'page.snapshot', mode: 'interactive' },
      })
    ).resolves.toMatchObject({
      sessionId: SESSION_ONE,
      tabId: 11,
      result: { action: 'page.snapshot', tabId: 11 },
    });
    expect(browser.tabs.has(11)).toBe(false);
    await expect(manager.execute({ action: 'browser.session.list' })).resolves.toEqual({
      sessions: [],
    });
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
    releases.splice(0).forEach(release => release());
    await Promise.all([first, concurrent]);

    await vi.waitFor(() => expect(started).toEqual([11, 12, 11]));
    releases.splice(0).forEach(release => release());
    await queued;
  });
});
