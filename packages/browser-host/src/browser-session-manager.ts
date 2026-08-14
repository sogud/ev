import { randomUUID } from 'node:crypto';
import {
  BrowserSessionCommandResultSchema,
  BrowserSessionCommandSchema,
  BrowserSessionScopedCommandSchema,
  BrowserSessionListResultSchema,
  BrowserSessionReleaseResultSchema,
  BrowserSessionSnapshotSchema,
  BrowserTabOpenResultSchema,
  BrowserTabsResultSchema,
  BrowserWindowOpenResultSchema,
  type BrowserAtomicCommand,
  type BrowserPageCommand,
  type BrowserSessionCommand,
  type BrowserSessionSnapshot,
  type BrowserSessionScopedCommand,
} from '@ev/contracts';

import { BrowserRunExecutor } from './browser-run-executor';

const MAX_SESSIONS = 32;
const MAX_SESSION_TABS = 32;

type AtomicCommandExecutor = (command: BrowserAtomicCommand) => Promise<unknown>;

function isPageCommand(command: BrowserAtomicCommand): command is BrowserPageCommand {
  return command.action.startsWith('page.');
}

interface BrowserSessionState {
  sessionId: string;
  windowId: number;
  ownedTabIds: Set<number>;
  borrowedTabIds: Set<number>;
  activeTabId?: number;
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSessionState>();
  private readonly tabOwners = new Map<number, string>();
  private readonly sessionTails = new Map<string, Promise<void>>();
  private ownershipTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly executeAtomic: AtomicCommandExecutor,
    private readonly createSessionId: () => string = randomUUID
  ) {}

  async execute(command: BrowserSessionCommand): Promise<unknown> {
    const parsed = BrowserSessionCommandSchema.parse(command);
    if (parsed.action === 'browser.session.create') return this.create(parsed.url);
    if (parsed.action === 'browser.session.list') return this.list();

    return this.enqueue(parsed.sessionId, async () => {
      const session = this.requireSession(parsed.sessionId);
      switch (parsed.action) {
        case 'browser.session.get':
          await this.refresh(session);
          return this.snapshot(session);
        case 'browser.session.open':
          return this.open(session, parsed.url, parsed.active ?? true);
        case 'browser.session.adoptTab':
          return this.adoptTab(session, parsed.tabId);
        case 'browser.session.command':
          return this.executeScoped(session, parsed.command);
        case 'browser.session.release':
          return this.release(session);
      }
    });
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

  private async create(url: string): Promise<BrowserSessionSnapshot> {
    return this.withOwnershipLock(async () => {
      if (this.sessions.size >= MAX_SESSIONS) {
        throw new Error(`Browser Host cannot exceed ${MAX_SESSIONS} BrowserSessions`);
      }

      const created = BrowserWindowOpenResultSchema.parse(
        await this.executeAtomic({ action: 'windows.open', url, focused: false })
      );
      const sessionId = this.createSessionId();
      if (this.sessions.has(sessionId) || this.tabOwners.has(created.tabId)) {
        await this.executeAtomic({ action: 'tabs.close', tabId: created.tabId });
        throw new Error('BrowserSession ownership collision');
      }

      const session: BrowserSessionState = {
        sessionId,
        windowId: created.windowId,
        ownedTabIds: new Set([created.tabId]),
        borrowedTabIds: new Set(),
        activeTabId: created.tabId,
      };
      this.sessions.set(sessionId, session);
      this.tabOwners.set(created.tabId, sessionId);
      return this.snapshot(session);
    });
  }

  private async list(): Promise<{ sessions: BrowserSessionSnapshot[] }> {
    const sessions = await Promise.all(
      [...this.sessions.keys()].map(sessionId =>
        this.enqueue(sessionId, async () => {
          const session = this.requireSession(sessionId);
          await this.refresh(session);
          return this.snapshot(session);
        })
      )
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
      await this.executeAtomic({
        action: 'tabs.open',
        url,
        windowId: session.windowId,
        active,
      })
    );
    if (created.windowId !== session.windowId || this.tabOwners.has(created.id)) {
      await this.executeAtomic({ action: 'tabs.close', tabId: created.id });
      throw new Error('Chrome created the tab outside the BrowserSession window');
    }

    session.ownedTabIds.add(created.id);
    this.tabOwners.set(created.id, session.sessionId);
    if (active) session.activeTabId = created.id;
    return this.snapshot(session);
  }

  private async adoptTab(
    session: BrowserSessionState,
    tabId: number
  ): Promise<BrowserSessionSnapshot> {
    await this.refresh(session);
    if (session.ownedTabIds.has(tabId) || session.borrowedTabIds.has(tabId)) {
      session.activeTabId = tabId;
      return this.snapshot(session);
    }
    this.assertTabCapacity(session);

    return this.withOwnershipLock(async () => {
      const owner = this.tabOwners.get(tabId);
      if (owner && owner !== session.sessionId) {
        throw new Error(`Tab ${tabId} already belongs to BrowserSession ${owner}`);
      }
      const tabs = BrowserTabsResultSchema.parse(await this.executeAtomic({ action: 'tabs.list' }));
      if (!tabs.some(tab => tab.id === tabId)) throw new Error(`Browser tab ${tabId} not found`);

      session.borrowedTabIds.add(tabId);
      session.activeTabId = tabId;
      this.tabOwners.set(tabId, session.sessionId);
      return this.snapshot(session);
    });
  }

  private async executeScoped(
    session: BrowserSessionState,
    command: BrowserSessionScopedCommand
  ): Promise<unknown> {
    await this.refresh(session);
    const requestedTabId = 'tabId' in command ? command.tabId : undefined;
    const tabId = requestedTabId ?? this.defaultTabId(session);
    this.assertOwnsTab(session, tabId);
    session.activeTabId = tabId;

    let result: unknown;
    if (command.action === 'browser.run') {
      result = await new BrowserRunExecutor(atomic =>
        this.executeScopedAtomic(session, atomic)
      ).execute({ ...command, tabId });
    } else {
      result = await this.executeScopedAtomic(session, { ...command, tabId });
    }
    return BrowserSessionCommandResultSchema.parse({ sessionId: session.sessionId, tabId, result });
  }

  private async executeScopedAtomic(
    session: BrowserSessionState,
    command: BrowserAtomicCommand
  ): Promise<unknown> {
    if (!isPageCommand(command)) {
      throw new Error('BrowserSession can only execute page commands');
    }
    const tabId = 'tabId' in command ? command.tabId : undefined;
    const scopedTabId = tabId ?? this.defaultTabId(session);
    this.assertOwnsTab(session, scopedTabId);
    return this.executeAtomic({ ...command, tabId: scopedTabId });
  }

  private async release(session: BrowserSessionState): Promise<unknown> {
    await this.refresh(session);
    const closedOwnedTabIds: number[] = [];
    for (const tabId of [...session.ownedTabIds]) {
      await this.executeAtomic({ action: 'tabs.close', tabId });
      session.ownedTabIds.delete(tabId);
      if (this.tabOwners.get(tabId) === session.sessionId) this.tabOwners.delete(tabId);
      closedOwnedTabIds.push(tabId);
    }

    const preservedBorrowedTabIds = [...session.borrowedTabIds];
    for (const tabId of preservedBorrowedTabIds) {
      if (this.tabOwners.get(tabId) === session.sessionId) this.tabOwners.delete(tabId);
    }
    this.sessions.delete(session.sessionId);
    return BrowserSessionReleaseResultSchema.parse({
      sessionId: session.sessionId,
      released: true,
      closedOwnedTabIds,
      preservedBorrowedTabIds,
    });
  }

  private async refresh(session: BrowserSessionState): Promise<void> {
    const tabs = BrowserTabsResultSchema.parse(await this.executeAtomic({ action: 'tabs.list' }));
    const liveTabIds = new Set(tabs.map(tab => tab.id));
    for (const tabId of [...session.ownedTabIds]) {
      if (liveTabIds.has(tabId)) continue;
      session.ownedTabIds.delete(tabId);
      if (this.tabOwners.get(tabId) === session.sessionId) this.tabOwners.delete(tabId);
    }
    for (const tabId of [...session.borrowedTabIds]) {
      if (liveTabIds.has(tabId)) continue;
      session.borrowedTabIds.delete(tabId);
      if (this.tabOwners.get(tabId) === session.sessionId) this.tabOwners.delete(tabId);
    }
    if (
      session.activeTabId !== undefined &&
      !session.ownedTabIds.has(session.activeTabId) &&
      !session.borrowedTabIds.has(session.activeTabId)
    ) {
      session.activeTabId = this.firstTabId(session);
    }
  }

  private snapshot(session: BrowserSessionState): BrowserSessionSnapshot {
    return BrowserSessionSnapshotSchema.parse({
      sessionId: session.sessionId,
      windowId: session.windowId,
      ownedTabIds: [...session.ownedTabIds],
      borrowedTabIds: [...session.borrowedTabIds],
      ...(session.activeTabId !== undefined ? { activeTabId: session.activeTabId } : {}),
    });
  }

  private requireSession(sessionId: string): BrowserSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`BrowserSession ${sessionId} not found`);
    return session;
  }

  private assertTabCapacity(session: BrowserSessionState): void {
    if (session.ownedTabIds.size + session.borrowedTabIds.size >= MAX_SESSION_TABS) {
      throw new Error(`BrowserSession cannot exceed ${MAX_SESSION_TABS} tabs`);
    }
  }

  private assertOwnsTab(session: BrowserSessionState, tabId: number): void {
    if (!session.ownedTabIds.has(tabId) && !session.borrowedTabIds.has(tabId)) {
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
    return (
      session.ownedTabIds.values().next().value ?? session.borrowedTabIds.values().next().value
    );
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
