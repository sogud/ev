import { beforeEach, describe, expect, it } from 'bun:test';
import type { TaskDetail, TaskSummary } from './domain';
import { createEvClient } from './client';

/** Fake socket: open/close/message are driven manually by the test. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.onopen?.();
  }

  close(): void {
    this.onclose?.();
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

let fetchCalls = 0;
let serverTasks: TaskSummary[] = [];

function summary(id: string, updatedAt: number): TaskSummary {
  return {
    id,
    title: id,
    cwd: '/tmp',
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
    thinkingLevel: 'medium',
  };
}

function detail(id: string, updatedAt: number): TaskDetail {
  return { ...summary(id, updatedAt), messages: [], trace: [] };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  fetchCalls = 0;
  serverTasks = [summary('t1', 100), summary('t2', 200)];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
    fetchCalls += 1;
    if (url.includes('/api/tasks/list')) {
      return { ok: true, json: async () => serverTasks.map(task => ({ ...task })) };
    }
    return { ok: true, json: async () => null };
  };
});

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('EvClient deep task sync', () => {
  it('opens no WebSocket until sync is enabled (CLI stays WS-free)', async () => {
    const client = createEvClient({ baseUrl: 'http://127.0.0.1:7877', token: 'x' });
    await client.tasks.list();
    expect(FakeWebSocket.instances.length).toBe(0);
    client.close();
  });

  it('taskList is read-through: one fetch, second read served from cache', async () => {
    const client = createEvClient({ baseUrl: 'http://127.0.0.1:7877', token: 'x' });
    client.enableTaskSync();
    const first = await client.taskList();
    expect(first.map(task => task.id)).toEqual(['t2', 't1']);
    const callsAfterFirst = fetchCalls;
    await client.taskList();
    expect(fetchCalls).toBe(callsAfterFirst);
    client.close();
  });

  it('tasks:update upserts the cache without refetching', async () => {
    const client = createEvClient({ baseUrl: 'http://127.0.0.1:7877', token: 'x' });
    client.enableTaskSync();
    await client.taskList();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    const seen: TaskSummary[][] = [];
    client.subscribeTaskList(tasks => seen.push(tasks));
    const callsBefore = fetchCalls;
    socket.emit({ channel: 'tasks:update', payload: detail('t3', 300) });

    expect(seen).toHaveLength(1);
    expect(seen[0].map(task => task.id)).toEqual(['t3', 't2', 't1']);
    expect(fetchCalls).toBe(callsBefore);
    client.close();
  });

  it('reconnect backoff: no instant reconnect storm, then automatic full refetch + onResynced', async () => {
    const client = createEvClient({ baseUrl: 'http://127.0.0.1:7877', token: 'x' });
    client.enableTaskSync();
    await client.taskList();
    const first = FakeWebSocket.instances[0];
    first.open();

    let resynced = 0;
    client.onResynced(() => {
      resynced += 1;
    });
    const seen: TaskSummary[][] = [];
    client.subscribeTaskList(tasks => seen.push(tasks));

    first.close();
    await sleep(300);
    // backoff starts at 1s: no reconnect attempt inside the first 300ms.
    expect(FakeWebSocket.instances.length).toBe(1);

    await sleep(900);
    expect(FakeWebSocket.instances.length).toBe(2);
    serverTasks = [summary('t9', 900)];
    FakeWebSocket.instances[1].open();
    await sleep(20);

    expect(resynced).toBe(1);
    expect(seen.at(-1)?.map(task => task.id)).toEqual(['t9']);
    client.close();
  });
});
