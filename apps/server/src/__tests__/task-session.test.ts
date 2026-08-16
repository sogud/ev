import os from 'node:os';
import type { RuntimeDescriptor, RuntimeEvent, RuntimeId, RuntimeSessionRef } from '@ev/contracts';
import type { TaskSummary, TraceEvent } from '@ev/contracts/domain';
import { Context } from 'cordis';
import { afterEach, describe, expect, it } from 'vitest';
import { DSH_COLD_RESUME_UNSUPPORTED, DshRuntimeAdapter } from '../runtime/dsh-runtime-adapter';
import {
  RuntimeSessionUnavailableError,
  type AgentRuntimeAdapter,
  type RuntimeSession,
  type RuntimeSessionInput,
  type RuntimeSessionRecord,
  type RuntimeSessionState,
} from '../runtime/runtime-adapter';
import { RuntimeRegistry } from '../runtime/runtime-registry';
import { TaskSession, type OwnerIndex, type TaskPersistence } from '../task-session';

// TaskSession depends only on the RuntimeRegistry plus two narrow ports
// (OwnerIndex, TaskPersistence); the whole concurrency suite needs no external
// mocks (neither the Store nor pi-coding-agent).

class FakeSession implements RuntimeSession {
  readonly runtimeId: RuntimeId;
  disposed = false;
  disposeCalls = 0;
  abortEvent: RuntimeEvent | undefined;
  disposeError: Error | undefined;
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

  async abort(): Promise<void> {
    if (this.abortEvent) this.emit(this.abortEvent);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.disposeDelayMs > 0)
      await new Promise(resolve => setTimeout(resolve, this.disposeDelayMs));
    if (this.disposeError) throw this.disposeError;
    this.disposed = true;
  }
}

class FakeAdapter implements AgentRuntimeAdapter {
  readonly id: RuntimeId;
  records: RuntimeSessionRecord[] = [];
  createCalls: RuntimeSessionInput[] = [];
  resumeCalls: RuntimeSessionInput[] = [];
  sessions: FakeSession[] = [];
  createDelayMs = 0;
  disposeDelayMs = 0;
  private nextNative = 0;
  private readonly seedMessage: boolean;

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

function makeOwnerIndex(): OwnerIndex {
  const owners = new Map<string, string>();
  return {
    owner: key => owners.get(key),
    acquire: (key, taskId) => {
      owners.set(key, taskId);
    },
    release: (key, taskId) => {
      if (owners.get(key) === taskId) owners.delete(key);
    },
    releaseAll: taskId => {
      for (const [key, owner] of owners) {
        if (owner === taskId) owners.delete(key);
      }
    },
  };
}

function makePersistence(): TaskPersistence & { traces: Map<string, TraceEvent[]> } {
  const traces = new Map<string, TraceEvent[]>();
  return {
    traces,
    saveTask: () => undefined,
    saveTrace: (taskId, trace) => {
      traces.set(taskId, trace);
    },
    loadTrace: taskId => traces.get(taskId) ?? [],
  };
}

const runtimeContexts: Context[] = [];

function makeRuntimeRegistry(...adapters: AgentRuntimeAdapter[]): RuntimeRegistry {
  const context = new Context();
  runtimeContexts.push(context);
  const registry = new RuntimeRegistry(context);
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

function makeSession(options: { seedPiMessage?: boolean; ownerIndex?: OwnerIndex } = {}) {
  const pi = new FakeAdapter('pi', options.seedPiMessage ?? false);
  const codex = new FakeAdapter('codex');
  const task = makeTask();
  const session = new TaskSession(
    task,
    {
      registry: makeRuntimeRegistry(pi, codex),
      ownerIndex: options.ownerIndex ?? makeOwnerIndex(),
      persistence: makePersistence(),
      bundledSkillPaths: [],
      systemPrompts: [],
    },
    true
  );
  return { session, task, pi, codex };
}

const sessions: TaskSession[] = [];

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(session => session.release()));
  await Promise.allSettled(runtimeContexts.splice(0).map(context => context.fiber.dispose()));
});

describe('TaskSession unavailable Runtime sessions', () => {
  it('keeps a cold DSH task identifiable and rejects resume explicitly', async () => {
    const pi = new FakeAdapter('pi');
    const dsh = new DshRuntimeAdapter();
    const task = makeTask();
    task.runtime = { runtimeId: 'dsh', nativeId: 'session-cold' };
    const session = new TaskSession(
      task,
      {
        registry: makeRuntimeRegistry(pi, dsh),
        ownerIndex: makeOwnerIndex(),
        persistence: makePersistence(),
        bundledSkillPaths: [],
        systemPrompts: [],
      },
      true
    );
    sessions.push(session);

    const error = await session.ensure().catch(value => value);
    expect(error).toBeInstanceOf(RuntimeSessionUnavailableError);
    expect(error).toMatchObject({ message: DSH_COLD_RESUME_UNSUPPORTED });
    expect(task.runtime).toEqual({ runtimeId: 'dsh', nativeId: 'session-cold' });
    await expect(dsh.listSessions()).resolves.toEqual([]);
  });
});

describe('TaskSession RuntimeEvent projection', () => {
  it('preserves a terminal runtime error emitted while aborting', async () => {
    const { session, task, pi } = makeSession();
    sessions.push(session);
    await session.ensure();
    pi.sessions[0].emit({ type: 'status', status: 'running' });
    pi.sessions[0].abortEvent = {
      type: 'status',
      status: 'error',
      error: 'Runtime task was stopped permanently',
    };

    await session.abort();

    expect(task).toMatchObject({
      status: 'error',
      error: 'Runtime task was stopped permanently',
    });
  });

  it('projects trace-only runtime events without adding transcript items', async () => {
    const { session, pi } = makeSession();
    sessions.push(session);
    await session.ensure();

    pi.sessions[0].emit({
      type: 'trace',
      id: 'subagent-1',
      traceType: 'tool',
      title: 'DSH subagent',
      detail: 'child-1',
      status: 'running',
      timestamp: 10,
    });

    expect(session.getState().messages).toEqual([]);
    expect(session.getState().trace).toContainEqual({
      id: 'subagent-1',
      type: 'tool',
      title: 'DSH subagent',
      detail: 'child-1',
      status: 'running',
      timestamp: 10,
    });
  });
});

describe('TaskSession.switchRuntime', () => {
  it('locks the runtime once the transcript has messages', async () => {
    const { session, task } = makeSession({ seedPiMessage: true });
    sessions.push(session);
    await session.ensure();
    expect(session.getState().messages).toHaveLength(1);

    await expect(session.switchRuntime('codex')).rejects.toThrow('runtime is locked');
    void task;
  });

  it('locks while the first turn is running even with an empty transcript', async () => {
    const { session, task } = makeSession();
    sessions.push(session);
    await session.ensure();
    task.status = 'running';

    await expect(session.switchRuntime('codex')).rejects.toThrow('runtime is locked');
  });

  it('drops the unused session and rebuilds with the new runtime', async () => {
    const { session, task, pi, codex } = makeSession();
    sessions.push(session);
    await session.ensure();
    expect(pi.createCalls).toHaveLength(1);
    const oldSession = pi.sessions[0];
    expect(task.runtime?.runtimeId).toBe('pi');

    await session.switchRuntime('codex');

    // lazy semantics: a switch only disposes the old session; the new one is built on first ensure.
    expect(oldSession.disposed).toBe(true);
    expect(codex.createCalls).toHaveLength(0);

    await session.ensure();
    expect(codex.createCalls).toHaveLength(1);
    expect(codex.resumeCalls).toHaveLength(0);
    expect(task.runtime?.runtimeId).toBe('codex');
  });

  it('releases the old session key so another task can take it', async () => {
    const ownerIndex = makeOwnerIndex();
    const first = makeSession({ ownerIndex });
    sessions.push(first.session);
    await first.session.ensure();
    const oldRef = first.task.runtime;
    expect(oldRef?.runtimeId).toBe('pi');

    await first.session.switchRuntime('codex');

    // the second task resumes the old native session directly; if switchRuntime had
    // not released the OwnerIndex this would falsely report the session as open in
    // another EV task.
    const second = makeSession({ ownerIndex });
    sessions.push(second.session);
    second.task.runtime = { runtimeId: 'pi', nativeId: oldRef?.nativeId ?? '' };
    await second.session.ensure();

    expect(second.pi.resumeCalls).toHaveLength(1);
    expect(second.task.runtime?.runtimeId).toBe('pi');
  });
});

// Regression tests for the three race windows flagged by the 2026-08-07 architecture
// review: (1) in-flight init write-back, (2) overlapping setRuntime, (3) resuming a
// dying session inside the dispose window.
describe('TaskSession race regressions', () => {
  it('releases session ownership even when runtime dispose fails', async () => {
    const ownerIndex = makeOwnerIndex();
    const { session, task, pi } = makeSession({ ownerIndex });
    sessions.push(session);
    await session.ensure();
    const key = `pi:${task.runtime?.nativeId ?? ''}`;
    expect(ownerIndex.owner(key)).toBe(task.id);
    pi.sessions[0].disposeError = new Error('dispose failed');

    await expect(session.release()).rejects.toThrow('dispose failed');

    expect(ownerIndex.owner(key)).toBeUndefined();
  });

  it('switchRuntime waits for an in-flight init and disposes its write-back', async () => {
    const { session, task, pi, codex } = makeSession();
    sessions.push(session);
    pi.createDelayMs = 20;
    const init = session.ensure();
    const switched = session.switchRuntime('codex');
    const [, switchedResult] = await Promise.allSettled([init, switched]);
    expect(switchedResult.status).toBe('fulfilled');

    // the old session must be disposed once born; the codex session is lazy until ensure, leaving no leak.
    expect(pi.sessions).toHaveLength(1);
    expect(pi.sessions[0].disposed).toBe(true);
    expect(codex.createCalls).toHaveLength(0);
    await session.ensure();
    expect(codex.createCalls).toHaveLength(1);
    expect(task.runtime?.runtimeId).toBe('codex');
  });

  it('overlapping switchRuntime calls serialize without double-dispose', async () => {
    const { session, task, pi, codex } = makeSession();
    sessions.push(session);
    await session.ensure();

    const first = session.switchRuntime('codex');
    const second = session.switchRuntime('pi');
    await Promise.all([first, second]);

    for (const fake of [...pi.sessions, ...codex.sessions]) {
      expect(fake.disposeCalls).toBeLessThanOrEqual(1);
    }
    // lazy semantics: the intermediate codex target is overwritten by the second switch and never spawns.
    expect(codex.createCalls).toHaveLength(0);
    await session.ensure();
    expect(pi.createCalls).toHaveLength(2); // initial + switch back
    expect(task.runtime?.runtimeId).toBe('pi');
  });

  it('concurrent ensure during the dispose window never resumes the dying ref', async () => {
    const { session, pi, codex } = makeSession();
    sessions.push(session);
    pi.disposeDelayMs = 20;
    await session.ensure();

    const switched = session.switchRuntime('codex');
    // enter after switchOnce has detached/cleared the ref, inside the dispose window.
    await new Promise(resolve => setTimeout(resolve, 5));
    const concurrent = session.ensure();
    await Promise.all([switched.catch(() => undefined), concurrent]);

    expect(pi.resumeCalls).toHaveLength(0);
    // the target is recorded before dispose: the concurrent ensure builds codex directly, never touching the dying pi.
    expect(pi.createCalls).toHaveLength(1);
    expect(codex.createCalls).toHaveLength(1);
  });
});
