import os from 'node:os';
import type { RuntimeDescriptor, RuntimeEvent, RuntimeId, RuntimeSessionRef } from '@ev/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskSummary, TranscriptItem } from '@ev/contracts/domain';
import type {
  AgentRuntimeAdapter,
  RuntimeSession,
  RuntimeSessionInput,
  RuntimeSessionRecord,
  RuntimeSessionState,
} from '../runtime/runtime-adapter';
import { RuntimeRegistry } from '../runtime/runtime-registry';
import { TaskSessionLifecycle } from '../task-session-lifecycle';

// TaskSessionLifecycle depends only on the RuntimeRegistry and callback hooks;
// the whole concurrency suite needs no external mocks (neither electron-store
// nor pi-coding-agent).

class FakeSession implements RuntimeSession {
  readonly runtimeId: RuntimeId;
  disposed = false;
  private readonly state: RuntimeSessionState;
  private readonly initialEvents: RuntimeEvent[];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(
    runtimeId: RuntimeId,
    nativeId: string,
    seedMessage: boolean,
    private readonly disposeDelayMs = 0
  ) {
    this.runtimeId = runtimeId;
    this.state = { ref: { runtimeId, nativeId }, status: 'idle' };
    this.initialEvents = seedMessage
      ? [{ type: 'message', id: `${nativeId}-m1`, role: 'user', content: '你好', timestamp: 1 }]
      : [];
  }

  getState(): RuntimeSessionState {
    return this.state;
  }

  getEvents(): RuntimeEvent[] {
    return [...this.initialEvents];
  }

  async prompt(): Promise<void> {}

  async promptAndWait(): Promise<void> {}

  async abort(): Promise<void> {}

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  disposeCalls = 0;

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.disposeDelayMs > 0)
      await new Promise(resolve => setTimeout(resolve, this.disposeDelayMs));
    this.disposed = true;
  }
}

class FakeAdapter implements AgentRuntimeAdapter {
  readonly id: RuntimeId;
  records: RuntimeSessionRecord[] = [];
  createCalls: RuntimeSessionInput[] = [];
  resumeCalls: RuntimeSessionInput[] = [];
  sessions: FakeSession[] = [];
  private nextNative = 0;
  private readonly seedMessage: boolean;
  createDelayMs = 0;
  disposeDelayMs = 0;

  constructor(id: RuntimeId, seedMessage = false) {
    this.id = id;
    this.seedMessage = seedMessage;
  }

  async describe(): Promise<RuntimeDescriptor> {
    return {
      id: this.id,
      name: this.id,
      availability: 'available',
      capabilities: {
        models: false,
        thinkingLevels: false,
        tools: true,
        resumeSession: true,
        structuredEvents: true,
        permissionModes: false,
      },
    };
  }

  async listSessions(): Promise<RuntimeSessionRecord[]> {
    return this.records;
  }

  async createSession(input: RuntimeSessionInput): Promise<RuntimeSession> {
    this.createCalls.push(input);
    if (this.createDelayMs > 0)
      await new Promise(resolve => setTimeout(resolve, this.createDelayMs));
    this.nextNative += 1;
    const session = new FakeSession(
      this.id,
      `${this.id}-native-${this.nextNative}`,
      this.seedMessage,
      this.disposeDelayMs
    );
    this.sessions.push(session);
    return session;
  }

  async resumeSession(
    input: RuntimeSessionInput & { session: RuntimeSessionRef }
  ): Promise<RuntimeSession> {
    this.resumeCalls.push(input);
    const session = new FakeSession(this.id, input.session.nativeId, false);
    this.sessions.push(session);
    return session;
  }

  async dispose(): Promise<void> {}
}

let seq = 0;

function makeTask(): TaskSummary {
  seq += 1;
  return {
    id: `task-${seq}`,
    title: 'New task',
    cwd: os.tmpdir(),
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    thinkingLevel: 'medium',
  };
}

function makeLifecycle(options: { seedPiMessage?: boolean } = {}) {
  const pi = new FakeAdapter('pi', options.seedPiMessage ?? false);
  const codex = new FakeAdapter('codex');
  const lifecycle = new TaskSessionLifecycle(new RuntimeRegistry([pi, codex]), [], [], {
    onEvent: () => undefined,
    messageFrom: (event): TranscriptItem => ({
      id: event.id,
      kind: event.role,
      content: event.content,
      timestamp: event.timestamp,
    }),
    loadTrace: () => [],
    ownsMetadata: () => true,
  });
  return { lifecycle, pi, codex };
}

const lifecycles: TaskSessionLifecycle[] = [];

afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map(lifecycle => lifecycle.disposeAll()));
});

describe('TaskSessionLifecycle.switchRuntime', () => {
  it('locks the runtime once the transcript has messages', async () => {
    const { lifecycle } = makeLifecycle({ seedPiMessage: true });
    lifecycles.push(lifecycle);
    const task = makeTask();
    const runtime = await lifecycle.ensure(task);
    expect(runtime.transcript.size).toBe(1);

    await expect(lifecycle.switchRuntime(task, 'codex')).rejects.toThrow('runtime is locked');
  });

  it('locks while the first turn is running even with an empty transcript', async () => {
    const { lifecycle } = makeLifecycle();
    lifecycles.push(lifecycle);
    const task = makeTask();
    await lifecycle.ensure(task);
    task.status = 'running';

    await expect(lifecycle.switchRuntime(task, 'codex')).rejects.toThrow('runtime is locked');
  });

  it('drops the unused session and rebuilds with the new runtime', async () => {
    const { lifecycle, pi, codex } = makeLifecycle();
    lifecycles.push(lifecycle);
    const task = makeTask();
    await lifecycle.ensure(task);
    expect(pi.createCalls).toHaveLength(1);
    const oldSession = pi.sessions[0];
    expect(task.runtime?.runtimeId).toBe('pi');

    await lifecycle.switchRuntime(task, 'codex');

    // lazy semantics: a switch only disposes the old session; the new one is built on first ensure.
    expect(oldSession.disposed).toBe(true);
    expect(codex.createCalls).toHaveLength(0);

    await lifecycle.ensure(task);
    expect(codex.createCalls).toHaveLength(1);
    expect(codex.resumeCalls).toHaveLength(0);
    expect(task.runtime?.runtimeId).toBe('codex');
  });

  it('releases the old session key so another task can take it', async () => {
    const { lifecycle, pi } = makeLifecycle();
    lifecycles.push(lifecycle);
    const task = makeTask();
    await lifecycle.ensure(task);
    const oldRef = task.runtime;
    expect(oldRef?.runtimeId).toBe('pi');

    await lifecycle.switchRuntime(task, 'codex');

    // the second task resumes the old native session directly; if switchRuntime had
    // not released sessionOwners this would falsely report the session as open in
    // another EV task.
    const second = makeTask();
    second.runtime = { runtimeId: 'pi', nativeId: oldRef?.nativeId ?? '' };
    await lifecycle.ensure(second);

    expect(pi.resumeCalls).toHaveLength(1);
    expect(second.runtime?.runtimeId).toBe('pi');
  });
});

// Regression tests for the three race windows flagged by the 2026-08-07 architecture
// review: (1) in-flight init write-back, (2) overlapping setRuntime, (3) resuming a
// dying session inside the dispose window.
describe('TaskSessionLifecycle race regressions', () => {
  it('switchRuntime waits for an in-flight init and disposes its write-back', async () => {
    const { lifecycle, pi, codex } = makeLifecycle();
    pi.createDelayMs = 20;
    const task = makeTask();
    const init = lifecycle.ensure(task);
    const switched = lifecycle.switchRuntime(task, 'codex');
    await Promise.all([init.catch(() => undefined), switched]);

    // the old session must be disposed once born; the codex session is lazy until ensure, leaving no leak.
    expect(pi.sessions).toHaveLength(1);
    expect(pi.sessions[0].disposed).toBe(true);
    expect(codex.createCalls).toHaveLength(0);
    await lifecycle.ensure(task);
    expect(codex.createCalls).toHaveLength(1);
    expect(task.runtime?.runtimeId).toBe('codex');
    expect(lifecycle.get(task.id)?.session.runtimeId).toBe('codex');
  });

  it('overlapping switchRuntime calls serialize without double-dispose', async () => {
    const { lifecycle, pi, codex } = makeLifecycle();
    const task = makeTask();
    await lifecycle.ensure(task);

    const first = lifecycle.switchRuntime(task, 'codex');
    const second = lifecycle.switchRuntime(task, 'pi');
    await Promise.all([first, second]);

    for (const session of [...pi.sessions, ...codex.sessions]) {
      expect(session.disposeCalls).toBeLessThanOrEqual(1);
    }
    // lazy semantics: the intermediate codex target is overwritten by the second switch and never spawns.
    expect(codex.createCalls).toHaveLength(0);
    await lifecycle.ensure(task);
    expect(pi.createCalls).toHaveLength(2); // initial + switch back
    expect(task.runtime?.runtimeId).toBe('pi');
    expect(lifecycle.get(task.id)?.session.runtimeId).toBe('pi');
  });

  it('concurrent ensure during the dispose window never resumes the dying ref', async () => {
    const { lifecycle, pi, codex } = makeLifecycle();
    pi.disposeDelayMs = 20;
    const task = makeTask();
    await lifecycle.ensure(task);

    const switched = lifecycle.switchRuntime(task, 'codex');
    // enter after switchOnce has detached active/cleared the ref, inside the dispose window.
    await new Promise(resolve => setTimeout(resolve, 5));
    const concurrent = lifecycle.ensure(task);
    await Promise.all([switched.catch(() => undefined), concurrent]);

    expect(pi.resumeCalls).toHaveLength(0);
    // desired is written before dispose: the concurrent ensure builds codex directly, never touching the dying pi.
    expect(pi.createCalls).toHaveLength(1);
    expect(codex.createCalls).toHaveLength(1);
  });
});
