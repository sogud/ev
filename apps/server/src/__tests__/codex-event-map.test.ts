import type { RuntimeEvent } from '@ev/contracts';
import { describe, expect, it } from 'vitest';
import type { CodexAppServerClient } from '../runtime/codex-app-server-client';
import { codexEffort, mapCodexItem } from '../runtime/codex-event-map';
import { CodexAppServerSession } from '../runtime/codex-app-server-session';

/** In-process fake client: notifications fire manually; turn/start returns increasing turn ids. */
class FakeClient {
  private notify?: (method: string, params: unknown) => void;
  private turnSeq = 0;

  constructor(private readonly completeOnStart = false) {}

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notify = listener;
    return () => undefined;
  }

  onExit(_listener: (error?: Error) => void): () => void {
    return () => undefined;
  }

  async start(): Promise<void> {}

  async request(method: string, _params: unknown): Promise<unknown> {
    if (method === 'turn/start') {
      this.turnSeq += 1;
      const id = `turn-${this.turnSeq}`;
      if (this.completeOnStart) {
        // extreme reordering: the completion arrives before the turn/start response.
        this.emit('turn/started', { threadId: 'thread-1', turn: { id } });
        this.emit('turn/completed', {
          threadId: 'thread-1',
          turn: { id, status: 'completed' },
        });
      }
      return { turn: { id } };
    }
    return {};
  }

  emit(method: string, params: unknown): void {
    this.notify?.(method, params);
  }
}

function makeSession(completeOnStart = false): {
  session: CodexAppServerSession;
  client: FakeClient;
} {
  const client = new FakeClient(completeOnStart);
  const session = new CodexAppServerSession(
    client as unknown as CodexAppServerClient,
    { id: 'thread-1', turns: [] },
    {}
  );
  return { session, client };
}

const threadId = 'thread-1';

describe('mapCodexItem table-driven mapping (every item kind)', () => {
  const cases: Array<{
    name: string;
    item: Record<string, unknown>;
    completed?: boolean;
    expect: (events: RuntimeEvent[]) => void;
  }> = [
    {
      name: 'userMessage joins text blocks',
      item: { id: 'u1', type: 'userMessage', content: [{ text: 'hello' }, { text: 'world' }] },
      expect: events =>
        expect(events).toEqual([
          expect.objectContaining({ role: 'user', content: 'hello\nworld' }),
        ]),
    },
    {
      name: 'userMessage without content array maps to empty text',
      item: { id: 'u2', type: 'userMessage' },
      expect: events =>
        expect(events).toEqual([expect.objectContaining({ role: 'user', content: '' })]),
    },
    {
      name: 'agentMessage maps to assistant',
      item: { id: 'a1', type: 'agentMessage', text: 'answer' },
      expect: events =>
        expect(events).toEqual([expect.objectContaining({ role: 'assistant', content: 'answer' })]),
    },
    {
      name: 'reasoning prefers summary over content',
      item: { id: 'r1', type: 'reasoning', summary: ['s'], content: ['c'] },
      expect: events =>
        expect(events).toEqual([expect.objectContaining({ role: 'thinking', content: 's' })]),
    },
    {
      name: 'reasoning falls back to content',
      item: { id: 'r2', type: 'reasoning', content: ['c'] },
      expect: events =>
        expect(events).toEqual([expect.objectContaining({ role: 'thinking', content: 'c' })]),
    },
    {
      name: 'commandExecution running',
      item: { id: 'c1', type: 'commandExecution', command: 'ls' },
      completed: false,
      expect: events =>
        expect(events[0]).toMatchObject({
          role: 'tool',
          toolName: 'command',
          toolStatus: 'running',
        }),
    },
    {
      name: 'commandExecution completed',
      item: { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed' },
      completed: true,
      expect: events => expect(events[0]).toMatchObject({ toolStatus: 'done' }),
    },
    {
      name: 'commandExecution failed',
      item: { id: 'c1', type: 'commandExecution', command: 'ls', status: 'failed' },
      completed: true,
      expect: events => expect(events[0]).toMatchObject({ toolStatus: 'error' }),
    },
    {
      name: 'fileChange carries toolName and done/running',
      item: { id: 'f1', type: 'fileChange' },
      completed: true,
      expect: events =>
        expect(events[0]).toMatchObject({
          role: 'tool',
          toolName: 'fileChange',
          toolStatus: 'done',
        }),
    },
    {
      name: 'mcpToolCall running',
      item: { id: 'm1', type: 'mcpToolCall' },
      completed: false,
      expect: events =>
        expect(events[0]).toMatchObject({ toolName: 'mcpToolCall', toolStatus: 'running' }),
    },
    {
      name: 'dynamicToolCall done',
      item: { id: 'd1', type: 'dynamicToolCall' },
      completed: true,
      expect: events =>
        expect(events[0]).toMatchObject({ toolName: 'dynamicToolCall', toolStatus: 'done' }),
    },
    {
      name: 'unknown kind maps to nothing',
      item: { id: 'x1', type: 'unknown' },
      expect: events => expect(events).toEqual([]),
    },
    {
      name: 'missing id falls back to a timestamp-derived id',
      item: { type: 'agentMessage', text: 'x' },
      expect: events => expect(events[0]).toMatchObject({ id: 'codex-7' }),
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      testCase.expect(mapCodexItem(testCase.item, 7, testCase.completed ?? true));
    });
  }

  it('codexEffort is the settled P2 table', () => {
    expect(
      (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(codexEffort)
    ).toEqual(['minimal', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra']);
  });
});

describe('Codex turn state machine (out-of-order turn-complete)', () => {
  const cases: Array<{
    name: string;
    run: (ctx: { session: CodexAppServerSession; client: FakeClient }) => Promise<void>;
  }> = [
    {
      name: 'completion arrives after waitForTurn -> resolve',
      run: async ({ session, client }) => {
        const prompt = session.promptAndWait('hi');
        // let performStartTurn consume the turn/start response, then simulate the server notification.
        await new Promise(resolve => setTimeout(resolve, 0));
        client.emit('turn/started', { threadId, turn: { id: 'turn-1' } });
        client.emit('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } });
        await prompt;
      },
    },
    {
      name: 'completion arrives before the turn/start response (extreme reorder) -> fast path',
      run: async () => {
        const { session } = makeSession(true);
        await session.promptAndWait('hi');
        expect(session.getState().status).toBe('idle');
      },
    },
    {
      name: 'failed turn -> reject with error state',
      run: async ({ session, client }) => {
        const prompt = session.promptAndWait('hi');
        client.emit('turn/started', { threadId, turn: { id: 'turn-1' } });
        client.emit('turn/completed', {
          threadId,
          turn: { id: 'turn-1', status: 'failed', error: 'boom' },
        });
        await expect(prompt).rejects.toThrow('boom');
        expect(session.getState().status).toBe('error');
      },
    },
    {
      name: 'a completion for another turn does not trip the current waiter',
      run: async ({ session, client }) => {
        const prompt = session.promptAndWait('hi');
        await new Promise(resolve => setTimeout(resolve, 0));
        client.emit('turn/started', { threadId, turn: { id: 'turn-1' } });
        client.emit('turn/completed', {
          threadId,
          turn: { id: 'other-turn', status: 'completed' },
        });
        // the waiter only accepts its own turnId: the prompt must still be unsettled here.
        const settled = await Promise.race([
          prompt.then(
            () => 'resolved',
            () => 'rejected'
          ),
          Promise.resolve('pending'),
        ]);
        expect(settled).toBe('pending');
        client.emit('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } });
        await prompt;
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => testCase.run(makeSession()));
  }

  it('delta accumulation overwrites same-id events', () => {
    const { session, client } = makeSession();
    const events: RuntimeEvent[] = [];
    session.subscribe(event => events.push(event));
    client.emit('item/agentMessage/delta', { threadId, itemId: 'm1', delta: 'Hel' });
    client.emit('item/agentMessage/delta', { threadId, itemId: 'm1', delta: 'lo' });
    const messages = events.filter(event => event.type === 'message');
    expect(messages.at(-1)).toMatchObject({ content: 'Hello' });
  });
});
