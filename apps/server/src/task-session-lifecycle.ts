import { stat } from 'node:fs/promises';
import type { RuntimeEvent, RuntimeId, RuntimeSessionRef } from '@ev/contracts';
import type { TaskSummary, TraceEvent, TranscriptItem } from '@ev/contracts/domain';
import { launchEnvironment } from './runtime/executable';
import type { RuntimeSession, RuntimeSessionInput } from './runtime/runtime-adapter';
import type { RuntimeRegistry } from './runtime/runtime-registry';

/** Task workspace missing/invalid; getTask uses it to mark the task unavailable without blocking startup. */
export class WorkspaceUnavailableError extends Error {}

export interface TaskRuntime {
  session: RuntimeSession;
  transcript: Map<string, TranscriptItem>;
  trace: Map<string, TraceEvent>;
  activeRunId?: string;
  unsubscribe: () => void;
}

export function sessionKey(ref: RuntimeSessionRef): string {
  return `${ref.runtimeId}:${ref.nativeId}`;
}

export function sameSession(
  left: RuntimeSessionRef | undefined,
  right: RuntimeSessionRef
): boolean {
  if (!left) return false;
  return (
    (left.runtimeId === right.runtimeId && left.nativeId === right.nativeId) ||
    Boolean(left.sessionFile && right.sessionFile && left.sessionFile === right.sessionFile)
  );
}

/**
 * Projection hooks: mapping/persistence/broadcast are not the lifecycle's job;
 * they stay in AgentService via these callbacks so this module only holds the
 * concurrency invariants and tests need no external mocks.
 */
export interface TaskSessionHooks {
  onEvent(task: TaskSummary, runtime: TaskRuntime, event: RuntimeEvent): void;
  messageFrom(event: Extract<RuntimeEvent, { type: 'message' }>): TranscriptItem;
  loadTrace(taskId: string): TraceEvent[];
  ownsMetadata(taskId: string): boolean;
}

/**
 * Task session lifecycle: create/resume/replace/release of the RuntimeSession
 * bound to a task, plus ownership arbitration. Invariants: the engine may change
 * before the first message (unstarted sessions are dropped and rebuilt), and the
 * session locks after the first message or once a turn is running; one native
 * session can never be held by two tasks (sessionOwners). Nothing is persisted
 * or broadcast here: the session ref on the task record is rewritten by this
 * module, while saving and emitting belong to the caller.
 */
export class TaskSessionLifecycle {
  private readonly active = new Map<string, TaskRuntime>();
  private readonly initializing = new Map<string, Promise<TaskRuntime>>();
  private readonly runtimeSwitches = new Map<string, Promise<void>>();
  private readonly sessionOwners = new Map<string, string>();

  constructor(
    private readonly runtimes: RuntimeRegistry,
    private readonly bundledSkillPaths: string[],
    private readonly systemPrompts: string[],
    private readonly hooks: TaskSessionHooks
  ) {}

  get(id: string): TaskRuntime | undefined {
    return this.active.get(id);
  }

  ensure(task: TaskSummary, suppliedRuntime?: RuntimeId): Promise<TaskRuntime> {
    const current = this.active.get(task.id);
    if (current) return Promise.resolve(current);
    const pending = this.initializing.get(task.id);
    if (pending) return pending;
    const initialization = this.initialize(task, suppliedRuntime).finally(() =>
      this.initializing.delete(task.id)
    );
    this.initializing.set(task.id, initialization);
    return initialization;
  }

  /**
   * Runtime switching is allowed before the first message; overlapping clicks are
   * serialized per task to prevent double dispose / double init. Once locked
   * (non-empty transcript or a running first turn) this throws.
   */
  async switchRuntime(task: TaskSummary, runtimeId: RuntimeId): Promise<void> {
    const previous = this.runtimeSwitches.get(task.id) ?? Promise.resolve();
    const wrapped: Promise<void> = previous
      .catch(() => undefined)
      .then(() => this.switchOnce(task, runtimeId))
      .finally(() => {
        if (this.runtimeSwitches.get(task.id) === wrapped) this.runtimeSwitches.delete(task.id);
      });
    this.runtimeSwitches.set(task.id, wrapped);
    await wrapped;
  }

  /**
   * Changing model/thinkingLevel before the first message: update the task record
   * and drop the built session (rebuilt lazily with the new config). Non-pi
   * runtimes cannot hot-swap mid-session; everything uses reconfigure=rebuild.
   */
  async reconfigure(
    task: TaskSummary,
    patch: { model?: TaskSummary['model']; thinkingLevel?: TaskSummary['thinkingLevel'] }
  ): Promise<void> {
    const pending = this.initializing.get(task.id);
    if (pending) await pending.catch(() => undefined);
    const current = this.active.get(task.id);
    if (current && (current.transcript.size > 0 || task.status === 'running')) {
      throw new Error('Conversation started; configuration is locked');
    }
    if (patch.model !== undefined) task.model = patch.model;
    if (patch.thinkingLevel !== undefined) task.thinkingLevel = patch.thinkingLevel;
    this.active.delete(task.id);
    if (task.runtime) this.sessionOwners.delete(sessionKey(task.runtime));
    task.runtime = undefined;
    task.sessionFile = undefined;
    if (current) {
      current.unsubscribe();
      await current.session.dispose();
    }
  }

  /** Effective/target runtime (pendingRuntimeId wins); used for UI and setModel routing. */
  peekRuntimeId(task: TaskSummary): RuntimeId {
    return task.pendingRuntimeId ?? task.runtime?.runtimeId ?? 'pi';
  }

  /** For removeTask: dispose and release every ownership record of the task. */
  async release(id: string): Promise<void> {
    const runtime =
      this.active.get(id) ?? (await this.initializing.get(id)?.catch(() => undefined));
    runtime?.unsubscribe();
    await runtime?.session.dispose();
    this.active.delete(id);
    this.initializing.delete(id);
    for (const [key, owner] of this.sessionOwners) {
      if (owner === id) this.sessionOwners.delete(key);
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled(this.initializing.values());
    for (const runtime of this.active.values()) {
      runtime.unsubscribe();
      await runtime.session.dispose();
    }
    this.active.clear();
    this.initializing.clear();
    this.sessionOwners.clear();
  }

  private async switchOnce(task: TaskSummary, runtimeId: RuntimeId): Promise<void> {
    // wait for an in-flight initialize to finish so it cannot write back to active
    // after dispose, leaking the old runtime and letting lock checks read stale state.
    const pending = this.initializing.get(task.id);
    if (pending) await pending.catch(() => undefined);
    const current = this.active.get(task.id);
    if (current && (current.transcript.size > 0 || task.status === 'running')) {
      throw new Error('Conversation started; runtime is locked');
    }
    // detach active, clear the ref and release ownership before dispose: a
    // concurrent ensure inside the dispose window then goes through createSession
    // instead of resuming a dying session. The ref is cleared even without a
    // current session, otherwise a lazy task would resume via the old ref.
    this.active.delete(task.id);
    if (task.runtime) this.sessionOwners.delete(sessionKey(task.runtime));
    task.runtime = undefined;
    task.sessionFile = undefined;
    // the target is recorded in pendingRuntimeId (persisted): the renderer shows it
    // immediately and it survives restarts; the session is built lazily on first
    // ensure, so the switch itself only pays the dispose cost.
    task.pendingRuntimeId = runtimeId;
    // a cross-runtime switch never carries the old model: non-pi models must be
    // picked explicitly from the target catalog (no cross-vocabulary accidents
    // like feeding gpt-5.4 to qoder).
    if (runtimeId !== 'pi') task.model = undefined;
    if (current) {
      current.unsubscribe();
      await current.session.dispose();
    }
    task.updatedAt = Date.now();
  }

  private async initialize(task: TaskSummary, suppliedRuntime?: RuntimeId): Promise<TaskRuntime> {
    await assertWorkspaceDirectory(task.cwd);
    const pending = task.pendingRuntimeId;
    const runtimeId = suppliedRuntime ?? pending ?? task.runtime?.runtimeId ?? 'pi';
    const adapter = this.runtimes.require(runtimeId);
    const requestedSessionKey = task.runtime ? sessionKey(task.runtime) : undefined;
    if (requestedSessionKey) {
      const owner = this.sessionOwners.get(requestedSessionKey);
      if (owner && owner !== task.id)
        throw new Error('This native session is already open in another EV task');
      this.sessionOwners.set(requestedSessionKey, task.id);
    }
    const input = await this.runtimeInput(task);
    let session: RuntimeSession;
    try {
      session = task.runtime
        ? await adapter.resumeSession({ ...input, session: task.runtime })
        : await adapter.createSession(input);
    } catch (error) {
      if (requestedSessionKey && this.sessionOwners.get(requestedSessionKey) === task.id) {
        this.sessionOwners.delete(requestedSessionKey);
      }
      throw error;
    }
    const state = session.getState();
    const nativeSessionKey = sessionKey(state.ref);
    const nativeOwner = this.sessionOwners.get(nativeSessionKey);
    if (nativeOwner && nativeOwner !== task.id) {
      await session.dispose();
      throw new Error('This native session is already open in another EV task');
    }
    this.sessionOwners.set(nativeSessionKey, task.id);
    task.runtime = state.ref;
    task.pendingRuntimeId = undefined;
    task.sessionFile = state.ref.sessionFile;
    task.model = state.model ?? task.model;
    task.thinkingLevel = state.thinkingLevel ?? task.thinkingLevel;

    const transcript = new Map<string, TranscriptItem>();
    for (const event of session.getEvents()) {
      if (event.type === 'message') transcript.set(event.id, this.hooks.messageFrom(event));
    }
    const runtime: TaskRuntime = {
      session,
      transcript,
      trace: new Map(this.hooks.loadTrace(task.id).map(item => [item.id, item])),
      unsubscribe: () => undefined,
    };
    runtime.unsubscribe = session.subscribe(event => this.hooks.onEvent(task, runtime, event));
    this.active.set(task.id, runtime);
    return runtime;
  }

  private async runtimeInput(task: TaskSummary): Promise<RuntimeSessionInput> {
    const ownsMetadata = this.hooks.ownsMetadata(task.id);
    return {
      cwd: task.cwd,
      name: task.title === 'New task' ? undefined : task.title,
      model: ownsMetadata ? task.model : undefined,
      thinkingLevel: ownsMetadata ? task.thinkingLevel : undefined,
      session: task.runtime,
      skillPaths: [...this.bundledSkillPaths],
      appendSystemPrompts: [...this.systemPrompts],
      // single child-env entry point: login-shell PATH + fallbacks + the EV launcher dir.
      environment: await launchEnvironment(),
    };
  }
}

/** Workspace directory validation shared by createTask and initialize; errors normalize to WorkspaceUnavailableError. */
export async function assertWorkspaceDirectory(value: string): Promise<void> {
  try {
    const info = await stat(value);
    if (!info.isDirectory())
      throw new WorkspaceUnavailableError(`Workspace is not a directory: ${value}`);
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new WorkspaceUnavailableError(`Workspace does not exist: ${value}`);
    }
    throw error;
  }
}
