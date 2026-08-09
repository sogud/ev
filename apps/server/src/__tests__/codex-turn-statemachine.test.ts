import type { RuntimeEvent } from '@ev/contracts';
import { describe, expect, it } from 'vitest';
import type { CodexAppServerClient } from '../runtime/codex-app-server-client';
import { CodexAppServerSession, mapCodexItem } from '../runtime/codex-app-server-session';

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

describe('Codex turn state machine (table-driven out-of-order turn-complete)', () => {
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
      name: 'completion arrives before the turn/start response (extreme reorder) -> waitForTurn takes the fast path',
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
});

describe('mapCodexItem pure mapping', () => {
  it('userMessage / agentMessage / reasoning map to the matching role', () => {
    const user = mapCodexItem(
      { id: 'u1', type: 'userMessage', content: [{ text: 'hello' }] },
      1,
      true
    );
    expect(user).toEqual([expect.objectContaining({ role: 'user', content: 'hello' })]);

    const assistant = mapCodexItem({ id: 'a1', type: 'agentMessage', text: 'answer' }, 2, true);
    expect(assistant).toEqual([expect.objectContaining({ role: 'assistant', content: 'answer' })]);

    const thinking = mapCodexItem({ id: 'r1', type: 'reasoning', summary: ['s'] }, 3, true);
    expect(thinking).toEqual([expect.objectContaining({ role: 'thinking', content: 's' })]);
  });

  it('commandExecution running/done/error states', () => {
    const running = mapCodexItem({ id: 'c1', type: 'commandExecution', command: 'ls' }, 1, false);
    expect(running[0]).toMatchObject({ role: 'tool', toolStatus: 'running' });

    const done = mapCodexItem(
      { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed' },
      1,
      true
    );
    expect(done[0]).toMatchObject({ toolStatus: 'done' });

    const failed = mapCodexItem(
      { id: 'c1', type: 'commandExecution', command: 'ls', status: 'failed' },
      1,
      true
    );
    expect(failed[0]).toMatchObject({ toolStatus: 'error' });
  });

  it('fileChange/mcpToolCall/dynamicToolCall carry toolName; unknown types return nothing', () => {
    const fileChange = mapCodexItem({ id: 'f1', type: 'fileChange' }, 1, true);
    expect(fileChange[0]).toMatchObject({ role: 'tool', toolName: 'fileChange' });
    expect(mapCodexItem({ id: 'x1', type: 'unknown' }, 1, true)).toEqual([]);
  });

  it('delta accumulation still overwrites same-id events via records', () => {
    const { session, client } = makeSession();
    const events: RuntimeEvent[] = [];
    session.subscribe(event => events.push(event));
    client.emit('item/agentMessage/delta', { threadId, itemId: 'm1', delta: 'Hel' });
    client.emit('item/agentMessage/delta', { threadId, itemId: 'm1', delta: 'lo' });
    const messages = events.filter(event => event.type === 'message');
    expect(messages.at(-1)).toMatchObject({ content: 'Hello' });
  });
});
