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

// TaskSessionLifecycle 只依赖 RuntimeRegistry 与回调钩子，
// 整组并发语义测试无需 mock 任何外部依赖（electron-store / pi-coding-agent 都不再需要）。

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
    title: '新任务',
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

    await expect(lifecycle.switchRuntime(task, 'codex')).rejects.toThrow('Runtime 已锁定');
  });

  it('locks while the first turn is running even with an empty transcript', async () => {
    const { lifecycle } = makeLifecycle();
    lifecycles.push(lifecycle);
    const task = makeTask();
    await lifecycle.ensure(task);
    task.status = 'running';

    await expect(lifecycle.switchRuntime(task, 'codex')).rejects.toThrow('Runtime 已锁定');
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

    // 延迟语义：切换只 dispose 旧会话，新会话首次 ensure 才建。
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

    // 第二个任务直接续跑旧原生会话；若 switchRuntime 没有释放 sessionOwners，
    // 这里会误报「该原生会话已在另一个 EV 任务中打开」。
    const second = makeTask();
    second.runtime = { runtimeId: 'pi', nativeId: oldRef?.nativeId ?? '' };
    await lifecycle.ensure(second);

    expect(pi.resumeCalls).toHaveLength(1);
    expect(second.runtime?.runtimeId).toBe('pi');
  });
});

// 架构审查（2026-08-07）指认的 3 个竞态窗口回归测试：
// ① in-flight init 回写 ② 重叠 setRuntime ③ dispose 窗口 resume 将死会话。
describe('TaskSessionLifecycle race regressions', () => {
  it('switchRuntime waits for an in-flight init and disposes its write-back', async () => {
    const { lifecycle, pi, codex } = makeLifecycle();
    pi.createDelayMs = 20;
    const task = makeTask();
    const init = lifecycle.ensure(task);
    const switched = lifecycle.switchRuntime(task, 'codex');
    await Promise.all([init.catch(() => undefined), switched]);

    // 旧会话出生后必须被 dispose；codex 会话延迟到 ensure 才建，终态无泄漏。
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
    // 延迟语义：中间目标 codex 被第二次切换覆盖，从不浪费 spawn。
    expect(codex.createCalls).toHaveLength(0);
    await lifecycle.ensure(task);
    expect(pi.createCalls).toHaveLength(2); // 初始 + 切回
    expect(task.runtime?.runtimeId).toBe('pi');
    expect(lifecycle.get(task.id)?.session.runtimeId).toBe('pi');
  });

  it('concurrent ensure during the dispose window never resumes the dying ref', async () => {
    const { lifecycle, pi, codex } = makeLifecycle();
    pi.disposeDelayMs = 20;
    const task = makeTask();
    await lifecycle.ensure(task);

    const switched = lifecycle.switchRuntime(task, 'codex');
    // 等 switchOnce 摘完 active/清完 ref、进入 dispose 悬置期再进入。
    await new Promise(resolve => setTimeout(resolve, 5));
    const concurrent = lifecycle.ensure(task);
    await Promise.all([switched.catch(() => undefined), concurrent]);

    expect(pi.resumeCalls).toHaveLength(0);
    // desired 先于 dispose 写入：并发 ensure 直接建 codex，不碰将死 pi。
    expect(pi.createCalls).toHaveLength(1);
    expect(codex.createCalls).toHaveLength(1);
  });
});
