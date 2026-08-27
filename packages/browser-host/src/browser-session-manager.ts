import { randomUUID } from 'node:crypto';
import {
  BrowserSessionCommandResultSchema,
  BrowserSessionCommandSchema,
  BrowserSessionScopedCommandSchema,
  BrowserSessionListResultSchema,
  BrowserSessionReleaseResultSchema,
  BrowserSessionSnapshotSchema,
  BrowserTabGroupSchema,
  BrowserTabOpenResultSchema,
  BrowserTabSchema,
  BrowserTabsResultSchema,
  BrowserWindowOpenResultSchema,
  type BrowserAtomicCommand,
  type BrowserOneShotCommand,
  type BrowserPageCommand,
  type BrowserSessionCommand,
  type BrowserSessionSnapshot,
  type BrowserSessionScopedCommand,
} from '@ev/contracts';

import { BrowserRunExecutor } from './browser-run-executor';

const MAX_SESSIONS = 32;
const MAX_SESSION_TABS = 32;

const SCOPED_TAB_ACTIONS = new Set([
  'tabs.get',
  'tabs.update',
  'tabs.move',
  'tabs.duplicate',
  'tabs.discard',
  'tabs.close',
  'tabs.activate',
]);

type AtomicCommandExecutor = (command: BrowserAtomicCommand, browserId: string) => Promise<unknown>;

function isPageCommand(command: BrowserAtomicCommand): command is BrowserPageCommand {
  return command.action.startsWith('page.');
}

function isTabScopedCommand(
  command: BrowserAtomicCommand
): command is Extract<BrowserAtomicCommand, { tabId: number }> {
  return SCOPED_TAB_ACTIONS.has(command.action);
}

interface BrowserSessionState {
  sessionId: string;
  /** Sessions are pinned to the browser that created them. */
  browserId: string;
  windowId: number;
  groupId: number;
  ownedTabIds: Set<number>;
  activeTabId?: number;
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSessionState>();
  private readonly tabOwners = new Map<string, string>();
  private readonly sessionTails = new Map<string, Promise<void>>();
  private ownershipTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly executeAtomic: AtomicCommandExecutor,
    private readonly createSessionId: () => string = randomUUID
  ) {}

  async execute(command: BrowserSessionCommand): Promise<unknown> {
    const parsed = BrowserSessionCommandSchema.parse(command);
    if (parsed.action === 'browser.session.create')
      return this.create(parsed.url, parsed.browserId);
    if (parsed.action === 'browser.session.list') return this.list();

    return this.enqueue(parsed.sessionId, async () => {
      const session = this.requireSession(parsed.sessionId);
      switch (parsed.action) {
        case 'browser.session.get':
          await this.refresh(session);
          return this.snapshot(session);
        case 'browser.session.open':
          return this.open(session, parsed.url, parsed.active ?? true);
        case 'browser.session.command':
          return this.executeScoped(session, parsed.command);
        case 'browser.session.release':
          return this.release(session);
      }
    });
  }

  async runOneShot(command: BrowserOneShotCommand): Promise<unknown> {
    const session = await this.create(command.url, command.browserId);
    try {
      const result = await this.execute({
        action: 'browser.session.command',
        sessionId: session.sessionId,
        command: command.command,
      });
      await this.execute({ action: 'browser.session.release', sessionId: session.sessionId });
      return result;
    } catch (error) {
      try {
        await this.execute({ action: 'browser.session.release', sessionId: session.sessionId });
      } catch {
        // Keep the command failure as the primary error.
      }
      throw error;
    }
  }

  async runExclusive<T>(
    sessionId: string,
    operation: (execute: (command: BrowserSessionScopedCommand) => Promise<unknown>) => Promise<T>
  ): Promise<T> {
    return this.enqueue(sessionId, async () => {
      const session = this.requireSession(sessionId);
      return operation(async command => {
        const scoped = BrowserSessionScopedCommandSchema.parse(command);
        const response = BrowserSessionCommandResultSchema.parse(
          await this.executeScoped(session, scoped)
        );
        return response.result;
      });
    });
  }

  private async create(
    url: string,
    browserId: string | undefined
  ): Promise<BrowserSessionSnapshot> {
    return this.withOwnershipLock(async () => {
      if (!browserId) {
        throw new Error('BrowserSession creation requires a resolved target browserId');
      }
      if (this.sessions.size >= MAX_SESSIONS) {
        throw new Error(`Browser Host cannot exceed ${MAX_SESSIONS} BrowserSessions`);
      }

      const sessionId = this.createSessionId();
      const created = BrowserWindowOpenResultSchema.parse(
        await this.executeAtomic({ action: 'windows.open', url, focused: false }, browserId)
      );
      if (
        this.sessions.has(sessionId) ||
        this.tabOwners.has(this.tabKey(browserId, created.tabId))
      ) {
        await this.executeAtomic({ action: 'tabs.close', tabId: created.tabId }, browserId);
        throw new Error('BrowserSession ownership collision');
      }

      let groupId: number;
      try {
        const group = BrowserTabGroupSchema.parse(
          await this.executeAtomic(
            {
              action: 'tabGroups.create',
              tabIds: [created.tabId],
              windowId: created.windowId,
              title: 'EV',
              color: 'cyan',
              collapsed: false,
            },
            browserId
          )
        );
        if (group.windowId !== created.windowId) {
          throw new Error('Chrome created the EV tab group outside the BrowserSession window');
        }
        groupId = group.id;
      } catch (error) {
        await this.executeAtomic({ action: 'tabs.close', tabId: created.tabId }, browserId);
        throw error;
      }

      const session: BrowserSessionState = {
        sessionId,
        browserId,
        windowId: created.windowId,
        groupId,
        ownedTabIds: new Set([created.tabId]),
        activeTabId: created.tabId,
      };
      this.sessions.set(sessionId, session);
      this.tabOwners.set(this.tabKey(browserId, created.tabId), sessionId);
      return this.snapshot(session);
    });
  }

  /** Tab ids are only unique inside one browser; ownership keys include the browser. */
  private tabKey(browserId: string, tabId: number): string {
    return `${browserId}:${tabId}`;
  }

  private async list(): Promise<{ sessions: BrowserSessionSnapshot[] }> {
    const snapshots = await Promise.all(
      [...this.sessions.keys()].map(sessionId =>
        this.enqueue(sessionId, async (): Promise<BrowserSessionSnapshot | undefined> => {
          const session = this.requireSession(sessionId);
          await this.refresh(session, true);
          if (session.ownedTabIds.size === 0) {
            // All tabs are gone (user closed the window/tab): drop the dead
            // session instead of failing the whole listing.
            this.sessions.delete(session.sessionId);
            return undefined;
          }
          return this.snapshot(session);
        })
      )
    );
    const sessions = snapshots.filter(
      (snapshot): snapshot is BrowserSessionSnapshot => snapshot !== undefined
    );
    return BrowserSessionListResultSchema.parse({ sessions });
  }

  private async open(
    session: BrowserSessionState,
    url: string,
    active: boolean
  ): Promise<BrowserSessionSnapshot> {
    await this.refresh(session);
    this.assertTabCapacity(session);
    const created = BrowserTabOpenResultSchema.parse(
      await this.executeAtomic(
        {
          action: 'tabs.open',
          url,
          windowId: session.windowId,
          active,
        },
        session.browserId
      )
    );
    if (
      created.windowId !== session.windowId ||
      this.tabOwners.has(this.tabKey(session.browserId, created.id))
    ) {
      await this.executeAtomic({ action: 'tabs.close', tabId: created.id }, session.browserId);
      throw new Error('Chrome created the tab outside the BrowserSession window');
    }

    try {
      await this.addToSessionGroup(session, created.id);
    } catch (error) {
      await this.executeAtomic({ action: 'tabs.close', tabId: created.id }, session.browserId);
      throw error;
    }
    session.ownedTabIds.add(created.id);
    this.tabOwners.set(this.tabKey(session.browserId, created.id), session.sessionId);
    if (active) session.activeTabId = created.id;
    return this.snapshot(session);
  }

  private async executeScoped(
    session: BrowserSessionState,
    command: BrowserSessionScopedCommand
  ): Promise<unknown> {
    await this.refresh(session);
    if (command.action === 'browser.run') {
      const tabId = command.tabId ?? this.defaultTabId(session);
      this.assertOwnsTab(session, tabId);
      session.activeTabId = tabId;
      const result = await new BrowserRunExecutor(atomic =>
        this.executeScopedAtomic(session, atomic)
      ).execute({ ...command, tabId });
      return BrowserSessionCommandResultSchema.parse({
        sessionId: session.sessionId,
        tabId,
        result,
      });
    }

    const atomic = command as BrowserAtomicCommand;
    if (isPageCommand(atomic) || atomic.action === 'zoom.get' || atomic.action === 'zoom.set') {
      const requestedTabId = 'tabId' in atomic ? atomic.tabId : undefined;
      const tabId = requestedTabId ?? this.defaultTabId(session);
      this.assertOwnsTab(session, tabId);
      session.activeTabId = tabId;
      const result = await this.executeAtomic(
        { ...atomic, tabId } as BrowserAtomicCommand,
        session.browserId
      );
      return BrowserSessionCommandResultSchema.parse({
        sessionId: session.sessionId,
        tabId,
        result,
      });
    }

    const tabId = this.defaultTabId(session);
    const result = await this.executeScopedWorkspace(session, atomic);
    return BrowserSessionCommandResultSchema.parse({ sessionId: session.sessionId, tabId, result });
  }

  private async executeScopedAtomic(
    session: BrowserSessionState,
    command: BrowserAtomicCommand
  ): Promise<unknown> {
    if (!isPageCommand(command)) {
      throw new Error('BrowserRun can only execute page commands');
    }
    const tabId = 'tabId' in command ? command.tabId : undefined;
    const scopedTabId = tabId ?? this.defaultTabId(session);
    this.assertOwnsTab(session, scopedTabId);
    return this.executeAtomic({ ...command, tabId: scopedTabId }, session.browserId);
  }

  private async executeScopedWorkspace(
    session: BrowserSessionState,
    command: BrowserAtomicCommand
  ): Promise<unknown> {
    if (command.action === 'tabs.list') {
      const tabs = BrowserTabsResultSchema.parse(
        await this.executeAtomic(command, session.browserId)
      );
      return tabs.filter(tab => session.ownedTabIds.has(tab.id));
    }
    if (isTabScopedCommand(command)) {
      this.assertOwnsTab(session, command.tabId);
    }

    switch (command.action) {
      case 'tabs.get':
      case 'tabs.discard':
      case 'tabs.activate':
        if (command.action === 'tabs.activate') session.activeTabId = command.tabId;
        return this.executeAtomic(command, session.browserId);
      case 'tabs.update': {
        if (command.pinned) {
          throw new Error(
            'BrowserSession tabs cannot be pinned because every tab must stay grouped'
          );
        }
        await this.executeAtomic(command, session.browserId);
        await this.addToSessionGroup(session, command.tabId);
        if (command.active) session.activeTabId = command.tabId;
        return this.executeAtomic({ action: 'tabs.get', tabId: command.tabId }, session.browserId);
      }
      case 'tabs.move':
        await this.executeAtomic({ ...command, windowId: session.windowId }, session.browserId);
        await this.addToSessionGroup(session, command.tabId);
        return this.executeAtomic({ action: 'tabs.get', tabId: command.tabId }, session.browserId);
      case 'tabs.duplicate': {
        this.assertTabCapacity(session);
        const duplicated = BrowserTabSchema.parse(
          await this.executeAtomic(command, session.browserId)
        );
        if (
          duplicated.windowId !== session.windowId ||
          this.tabOwners.has(this.tabKey(session.browserId, duplicated.id))
        ) {
          await this.executeAtomic(
            { action: 'tabs.close', tabId: duplicated.id },
            session.browserId
          );
          throw new Error('Chrome duplicated the tab outside the BrowserSession window');
        }
        try {
          await this.addToSessionGroup(session, duplicated.id);
        } catch (error) {
          await this.executeAtomic(
            { action: 'tabs.close', tabId: duplicated.id },
            session.browserId
          );
          throw error;
        }
        session.ownedTabIds.add(duplicated.id);
        this.tabOwners.set(this.tabKey(session.browserId, duplicated.id), session.sessionId);
        return this.executeAtomic({ action: 'tabs.get', tabId: duplicated.id }, session.browserId);
      }
      case 'tabs.close':
        if (session.ownedTabIds.size === 1) {
          throw new Error('Release the BrowserSession instead of closing its last tab');
        }
        await this.executeAtomic(command, session.browserId);
        session.ownedTabIds.delete(command.tabId);
        this.tabOwners.delete(this.tabKey(session.browserId, command.tabId));
        if (session.activeTabId === command.tabId) session.activeTabId = this.firstTabId(session);
        return { closed: true, tabId: command.tabId };
      case 'windows.list': {
        const windows = await this.executeAtomic(command, session.browserId);
        if (!Array.isArray(windows)) return [];
        return windows.filter(
          window =>
            window && typeof window === 'object' && 'id' in window && window.id === session.windowId
        );
      }
      case 'windows.update':
        if (command.windowId !== session.windowId) {
          throw new Error(
            `BrowserSession ${session.sessionId} does not own window ${command.windowId}`
          );
        }
        return this.executeAtomic(command, session.browserId);
      case 'tabGroups.list': {
        const groups = await this.executeAtomic(
          {
            action: 'tabGroups.list',
            windowId: session.windowId,
          },
          session.browserId
        );
        if (!Array.isArray(groups)) return [];
        return groups.filter(
          group =>
            group && typeof group === 'object' && 'id' in group && group.id === session.groupId
        );
      }
      case 'tabGroups.update':
        if (command.groupId !== session.groupId) {
          throw new Error(
            `BrowserSession ${session.sessionId} does not own group ${command.groupId}`
          );
        }
        return this.executeAtomic(command, session.browserId);
      default:
        throw new Error(`BrowserSession cannot execute workspace action ${command.action}`);
    }
  }

  private async release(session: BrowserSessionState): Promise<unknown> {
    await this.refresh(session, true);
    const closedOwnedTabIds: number[] = [];
    for (const tabId of [...session.ownedTabIds]) {
      await this.executeAtomic({ action: 'tabs.close', tabId }, session.browserId);
      session.ownedTabIds.delete(tabId);
      const key = this.tabKey(session.browserId, tabId);
      if (this.tabOwners.get(key) === session.sessionId) this.tabOwners.delete(key);
      closedOwnedTabIds.push(tabId);
    }

    this.sessions.delete(session.sessionId);
    return BrowserSessionReleaseResultSchema.parse({
      sessionId: session.sessionId,
      released: true,
      closedOwnedTabIds,
    });
  }

  private async refresh(session: BrowserSessionState, allowEmpty = false): Promise<void> {
    const tabs = BrowserTabsResultSchema.parse(
      await this.executeAtomic({ action: 'tabs.list' }, session.browserId)
    );
    const liveTabs = new Map(tabs.map(tab => [tab.id, tab]));
    for (const tabId of [...session.ownedTabIds]) {
      if (liveTabs.has(tabId)) continue;
      session.ownedTabIds.delete(tabId);
      const key = this.tabKey(session.browserId, tabId);
      if (this.tabOwners.get(key) === session.sessionId) this.tabOwners.delete(key);
    }
    if (session.ownedTabIds.size === 0) {
      session.activeTabId = undefined;
      if (!allowEmpty) throw new Error(`BrowserSession ${session.sessionId} has no live tabs`);
      return;
    }

    for (const tabId of session.ownedTabIds) {
      const tab = liveTabs.get(tabId);
      if (!tab || (tab.windowId === session.windowId && tab.groupId === session.groupId)) continue;
      await this.addToSessionGroup(session, tabId);
    }
    const activeOwnedTab = tabs.find(tab => tab.active && session.ownedTabIds.has(tab.id));
    if (activeOwnedTab) session.activeTabId = activeOwnedTab.id;
    if (session.activeTabId === undefined || !session.ownedTabIds.has(session.activeTabId)) {
      session.activeTabId = this.firstTabId(session);
    }
  }

  private async addToSessionGroup(session: BrowserSessionState, tabId: number): Promise<void> {
    const group = BrowserTabGroupSchema.parse(
      await this.executeAtomic(
        {
          action: 'tabGroups.add',
          groupId: session.groupId,
          tabIds: [tabId],
        },
        session.browserId
      )
    );
    if (group.id !== session.groupId || group.windowId !== session.windowId) {
      throw new Error('Chrome moved the tab outside the BrowserSession group');
    }
  }

  private snapshot(session: BrowserSessionState): BrowserSessionSnapshot {
    return BrowserSessionSnapshotSchema.parse({
      sessionId: session.sessionId,
      browserId: session.browserId,
      windowId: session.windowId,
      groupId: session.groupId,
      ownedTabIds: [...session.ownedTabIds],
      activeTabId: this.defaultTabId(session),
    });
  }

  private requireSession(sessionId: string): BrowserSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`BrowserSession ${sessionId} not found`);
    return session;
  }

  private assertTabCapacity(session: BrowserSessionState): void {
    if (session.ownedTabIds.size >= MAX_SESSION_TABS) {
      throw new Error(`BrowserSession cannot exceed ${MAX_SESSION_TABS} tabs`);
    }
  }

  private assertOwnsTab(session: BrowserSessionState, tabId: number): void {
    if (!session.ownedTabIds.has(tabId)) {
      throw new Error(`BrowserSession ${session.sessionId} does not own tab ${tabId}`);
    }
  }

  private defaultTabId(session: BrowserSessionState): number {
    const tabId = session.activeTabId ?? this.firstTabId(session);
    if (tabId === undefined)
      throw new Error(`BrowserSession ${session.sessionId} has no live tabs`);
    return tabId;
  }

  private firstTabId(session: BrowserSessionState): number | undefined {
    return session.ownedTabIds.values().next().value;
  }

  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    const run = previous.then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.sessionTails.set(sessionId, tail);
    return run.finally(() => {
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    });
  }

  private withOwnershipLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.ownershipTail.then(operation);
    this.ownershipTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
