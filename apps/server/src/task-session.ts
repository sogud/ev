import { stat } from 'node:fs/promises';
import type { RuntimeEvent, RuntimeId, RuntimeSessionRef } from '@ev/contracts';
import type {
  CommandInfo,
  PromptImage,
  TaskDetail,
  TaskInspection,
  TaskSummary,
  ThinkingLevel,
  TraceEvent,
  TranscriptItem,
} from '@ev/contracts/domain';
import { launchEnvironment } from './runtime/executable';
import type { RuntimeSession, RuntimeSessionInput } from './runtime/runtime-adapter';
import type { RuntimeRegistry } from './runtime/runtime-registry';
import { taskTitleFromPrompt } from './task-title';
import { inspectWorkspace } from './workspace-inspection';

/** Task workspace missing/invalid; getTask uses it to mark the task unavailable without blocking startup. */
export class WorkspaceUnavailableError extends Error {}

const MAX_PROMPT_IMAGES = 4;
const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;
const PROMPT_IMAGE_TYPES = new Set<PromptImage['mimeType']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

function promptImageBytes(data: unknown, mimeType: PromptImage['mimeType']): Buffer {
  if (
    typeof data !== 'string' ||
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    throw new Error('Image data must be valid base64');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_PROMPT_IMAGE_BYTES) throw new Error('Each image must be 5 MB or smaller');
  const validSignature =
    (mimeType === 'image/png' &&
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ||
    (mimeType === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) ||
    (mimeType === 'image/gif' &&
      ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) ||
    (mimeType === 'image/webp' &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!validSignature) throw new Error(`Image data does not match ${mimeType}`);
  return bytes;
}

function parsePromptImages(value: unknown): PromptImage[] {
  if (!Array.isArray(value)) throw new Error('Prompt images must be an array');
  if (value.length > MAX_PROMPT_IMAGES) throw new Error('A prompt can include at most 4 images');
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Prompt image is invalid');
    const image = item as Record<string, unknown>;
    if (
      image.type !== 'image' ||
      !PROMPT_IMAGE_TYPES.has(image.mimeType as PromptImage['mimeType'])
    ) {
      throw new Error('Prompt image type is unsupported');
    }
    const mimeType = image.mimeType as PromptImage['mimeType'];
    promptImageBytes(image.data, mimeType);
    if (
      image.fileName !== undefined &&
      (typeof image.fileName !== 'string' || image.fileName.length > 255)
    ) {
      throw new Error('Prompt image filename is invalid');
    }
    return {
      type: 'image',
      data: image.data as string,
      mimeType,
      ...(typeof image.fileName === 'string' ? { fileName: image.fileName } : {}),
    };
  });
}

function parseQueueMode(value: unknown): 'steer' | 'followUp' {
  if (value === 'steer' || value === 'followUp') return value;
  throw new Error('Prompt queue mode must be steer or followUp');
}

/** Live bundle behind a Task: native session plus its Transcript/Trace projections. */
interface TaskRuntimeState {
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
 * Cross-task native-session ownership data. The registry (AgentService) holds
 * the map; the arbitration rules (one native session, one task) live in
 * TaskSession, which receives this index as a dependency.
 */
export interface OwnerIndex {
  owner(key: string): string | undefined;
  acquire(key: string, taskId: string): void;
  release(key: string, taskId: string): void;
  releaseAll(taskId: string): void;
}

/**
 * Narrow write mechanism. TaskSession decides what and when to persist; the
 * registry implements the port over the shared Store.
 */
export interface TaskPersistence {
  saveTask(task: TaskSummary): void;
  saveTrace(taskId: string, trace: TraceEvent[]): void;
  loadTrace(taskId: string): TraceEvent[];
}

export interface TaskSessionDeps {
  registry: RuntimeRegistry;
  ownerIndex: OwnerIndex;
  persistence: TaskPersistence;
  bundledSkillPaths: string[];
  systemPrompts: string[];
}

/**
 * TaskSession — the deep per-Task module (CONTEXT.md, 2026-08-10 review).
 * Owns the RuntimeSession bound to a Task, the Transcript/Trace projections,
 * the status state-machine and its own persistence; exposes a synchronous
 * snapshot plus subscribe(). Concurrency invariants: the engine may change
 * before the first message (unstarted sessions are dropped and rebuilt), the
 * session locks after the first message or while a turn runs, and one native
 * session can never be held by two tasks (rules here, OwnerIndex data in the
 * registry). The module knows nothing about WS/broadcast: the registry
 * subscribes and fans out.
 */
export class TaskSession {
  private runtime?: TaskRuntimeState;
  private initializing?: Promise<TaskRuntimeState>;
  private switches?: Promise<void>;
  private readonly listeners = new Set<(detail: TaskDetail) => void>();

  constructor(
    readonly task: TaskSummary,
    private readonly deps: TaskSessionDeps,
    private readonly ownsMetadata: boolean
  ) {}

  subscribe(listener: (detail: TaskDetail) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Synchronous snapshot; without a live session the persisted trace is shown. */
  getState(): TaskDetail {
    if (!this.runtime) {
      return {
        ...this.task,
        messages: [],
        trace: this.deps.persistence.loadTrace(this.task.id),
      };
    }
    const { transcript, trace } = this.runtime;
    return {
      ...this.task,
      messages: [...transcript.values()].sort((a, b) => a.timestamp - b.timestamp),
      trace: [...trace.values()].sort((a, b) => a.timestamp - b.timestamp),
    };
  }

  /** Effective/target runtime (pendingRuntimeId wins); used for UI and setModel routing. */
  peekRuntimeId(): RuntimeId {
    return this.task.pendingRuntimeId ?? this.task.runtime?.runtimeId ?? 'pi';
  }

  async ensure(): Promise<void> {
    await this.ensureState();
  }

  async prompt(prompt: string, images: unknown = [], queue: unknown = 'steer'): Promise<void> {
    if (typeof prompt !== 'string') throw new Error('Prompt must be a string');
    const text = prompt.trim();
    const parsedImages = parsePromptImages(images);
    const parsedQueue = parseQueueMode(queue);
    if (!text && parsedImages.length === 0) return;
    const runtime = await this.ensureState();

    // Mid-turn input: queue into the running session (steer/follow_up) without
    // touching task status; the queued text surfaces when Pi delivers it.
    if (this.task.status === 'running') {
      const queueFn = runtime.session.queueMessage?.bind(runtime.session);
      if (!queueFn) throw new Error('This runtime does not support queueing messages');
      await queueFn(text, parsedQueue, parsedImages);
      return;
    }

    if (this.task.title === 'New task') {
      this.task.title = taskTitleFromPrompt(text || 'Image attachment');
    }
    this.task.status = 'running';
    this.task.error = undefined;
    this.task.updatedAt = Date.now();
    this.persistTask();
    this.notify();

    const run = runtime.session.promptAndWait(text, parsedImages).catch((error: unknown) => {
      this.task.status = 'error';
      this.task.error = error instanceof Error ? error.message : String(error);
      this.task.updatedAt = Date.now();
      this.addErrorTrace(this.task.error);
      this.persistTask();
      this.persistTrace();
      this.notify();
    });
    void run;
  }

  async commands(): Promise<CommandInfo[]> {
    const runtime = await this.ensureState();
    if (!runtime.session.listCommands) return [];
    return await runtime.session.listCommands();
  }

  async abort(): Promise<void> {
    const runtime = await this.ensureState();
    await runtime.session.abort();
    if (this.task.status === 'running') {
      this.task.status = 'idle';
      this.task.error = undefined;
    }
    this.task.updatedAt = Date.now();
    this.persistTask();
    this.notify();
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    if (this.peekRuntimeId() === 'pi') {
      const runtime = await this.ensureState();
      if (!runtime.session.setModel) throw new Error('pi does not support model switching');
      await runtime.session.setModel(provider, modelId);
      return;
    }
    // non-pi: before the first message a reconfigure rebuilds the session; afterwards it throws and locks.
    await this.reconfigure({ model: { provider, id: modelId, name: modelId } });
    this.persistTask();
    this.notifyEmpty();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    if (this.peekRuntimeId() === 'pi') {
      const runtime = await this.ensureState();
      if (!runtime.session.setThinkingLevel)
        throw new Error('pi does not support thinking-level switching');
      await runtime.session.setThinkingLevel(level);
      return;
    }
    await this.reconfigure({ thinkingLevel: level });
    this.persistTask();
    this.notifyEmpty();
  }

  /**
   * Runtime switching is allowed before the first message (the chip row under
   * the composer is the only caller; the sidebar is display-only). Overlapping
   * switches are serialized per task to prevent double dispose / double init.
   */
  async switchRuntime(runtimeId: RuntimeId): Promise<void> {
    const previous = this.switches ?? Promise.resolve();
    const wrapped: Promise<void> = previous
      .catch(() => undefined)
      .then(() => this.switchOnce(runtimeId))
      .finally(() => {
        if (this.switches === wrapped) this.switches = undefined;
      });
    this.switches = wrapped;
    await wrapped;
    this.persistTask();
    // sessions are lazy: a switch only pays the dispose cost, and broadcasting an
    // empty transcript/trace lets the renderer update immediately (P1).
    this.notifyEmpty();
  }

  async inspect(): Promise<TaskInspection> {
    const runtime = await this.ensureState();
    return {
      trace: [...runtime.trace.values()].sort((a, b) => a.timestamp - b.timestamp),
      changes: await inspectWorkspace(this.task.cwd),
    };
  }

  /** For removeTask/shutdown: dispose and release every ownership record of the task. */
  async release(): Promise<void> {
    const runtime = this.runtime ?? (await this.initializing?.catch(() => undefined));
    runtime?.unsubscribe();
    try {
      await runtime?.session.dispose();
    } finally {
      this.runtime = undefined;
      this.initializing = undefined;
      this.deps.ownerIndex.releaseAll(this.task.id);
    }
  }

  private ensureState(): Promise<TaskRuntimeState> {
    if (this.runtime) return Promise.resolve(this.runtime);
    if (this.initializing) return this.initializing;
    const initialization = this.initialize().finally(() => {
      this.initializing = undefined;
    });
    this.initializing = initialization;
    return initialization;
  }

  /**
   * Changing model/thinkingLevel before the first message: update the task
   * record and drop the built session (rebuilt lazily with the new config).
   * Non-pi runtimes cannot hot-swap mid-session; reconfigure always rebuilds.
   */
  private async reconfigure(patch: {
    model?: TaskSummary['model'];
    thinkingLevel?: TaskSummary['thinkingLevel'];
  }): Promise<void> {
    await this.initializing?.catch(() => undefined);
    const current = this.runtime;
    if (current && (current.transcript.size > 0 || this.task.status === 'running')) {
      throw new Error('Conversation started; configuration is locked');
    }
    if (patch.model !== undefined) this.task.model = patch.model;
    if (patch.thinkingLevel !== undefined) this.task.thinkingLevel = patch.thinkingLevel;
    this.detach(current);
  }

  private async switchOnce(runtimeId: RuntimeId): Promise<void> {
    // wait for an in-flight initialize to finish so it cannot write back after
    // dispose, leaking the old runtime and letting lock checks read stale state.
    await this.initializing?.catch(() => undefined);
    const current = this.runtime;
    if (current && (current.transcript.size > 0 || this.task.status === 'running')) {
      throw new Error('Conversation started; runtime is locked');
    }
    // detach, clear the ref and release ownership before dispose: a concurrent
    // ensure inside the dispose window then creates instead of resuming a dying
    // session. The ref is cleared even without a current session, otherwise a
    // lazy task would resume via the old ref.
    this.detach(current);
    // the target is recorded in pendingRuntimeId (persisted): the renderer shows
    // it immediately and it survives restarts; the session is built lazily on
    // first ensure, so the switch itself only pays the dispose cost.
    this.task.pendingRuntimeId = runtimeId;
    // a cross-runtime switch never carries the old model: non-pi models must be
    // picked explicitly from the target catalog (no cross-vocabulary accidents
    // like feeding gpt-5.4 to qoder).
    if (runtimeId !== 'pi') this.task.model = undefined;
    this.task.updatedAt = Date.now();
  }

  private detach(current: TaskRuntimeState | undefined): void {
    this.runtime = undefined;
    if (this.task.runtime)
      this.deps.ownerIndex.release(sessionKey(this.task.runtime), this.task.id);
    this.task.runtime = undefined;
    this.task.sessionFile = undefined;
    if (current) {
      current.unsubscribe();
      void current.session.dispose();
    }
  }

  private async initialize(): Promise<TaskRuntimeState> {
    const task = this.task;
    await assertWorkspaceDirectory(task.cwd);
    const pending = task.pendingRuntimeId;
    const runtimeId = pending ?? task.runtime?.runtimeId ?? 'pi';
    const adapter = this.deps.registry.require(runtimeId);
    const requestedSessionKey = task.runtime ? sessionKey(task.runtime) : undefined;
    if (requestedSessionKey) {
      const owner = this.deps.ownerIndex.owner(requestedSessionKey);
      if (owner && owner !== task.id)
        throw new Error('This native session is already open in another EV task');
      this.deps.ownerIndex.acquire(requestedSessionKey, task.id);
    }
    const input = await this.runtimeInput(task);
    let session: RuntimeSession;
    try {
      session = task.runtime
        ? await adapter.resumeSession({ ...input, session: task.runtime })
        : await adapter.createSession(input);
    } catch (error) {
      if (requestedSessionKey && this.deps.ownerIndex.owner(requestedSessionKey) === task.id) {
        this.deps.ownerIndex.release(requestedSessionKey, task.id);
      }
      throw error;
    }
    const state = session.getState();
    const nativeSessionKey = sessionKey(state.ref);
    const nativeOwner = this.deps.ownerIndex.owner(nativeSessionKey);
    if (nativeOwner && nativeOwner !== task.id) {
      await session.dispose();
      throw new Error('This native session is already open in another EV task');
    }
    this.deps.ownerIndex.acquire(nativeSessionKey, task.id);
    task.runtime = state.ref;
    task.pendingRuntimeId = undefined;
    task.sessionFile = state.ref.sessionFile;
    task.model = state.model ?? task.model;
    task.thinkingLevel = state.thinkingLevel ?? task.thinkingLevel;

    const transcript = new Map<string, TranscriptItem>();
    for (const event of session.getEvents()) {
      if (event.type === 'message') transcript.set(event.id, this.transcriptFrom(event));
    }
    const runtime: TaskRuntimeState = {
      session,
      transcript,
      trace: new Map(this.deps.persistence.loadTrace(task.id).map(item => [item.id, item])),
      unsubscribe: () => undefined,
    };
    runtime.unsubscribe = session.subscribe(event => this.onRuntimeEvent(runtime, event));
    this.runtime = runtime;
    return runtime;
  }

  private async runtimeInput(task: TaskSummary): Promise<RuntimeSessionInput> {
    return {
      cwd: task.cwd,
      name: task.title === 'New task' ? undefined : task.title,
      model: this.ownsMetadata ? task.model : undefined,
      thinkingLevel: this.ownsMetadata ? task.thinkingLevel : undefined,
      session: task.runtime,
      skillPaths: [...this.deps.bundledSkillPaths],
      appendSystemPrompts: [...this.deps.systemPrompts],
      // single child-env entry point: login-shell PATH + fallbacks + the EV launcher dir.
      environment: await launchEnvironment(),
    };
  }

  private onRuntimeEvent(runtime: TaskRuntimeState, event: RuntimeEvent): void {
    const task = this.task;
    if (event.type === 'message') {
      runtime.transcript.set(event.id, this.transcriptFrom(event));
      if (event.role === 'tool') {
        runtime.trace.set(event.id, {
          id: event.id,
          type: 'tool',
          title: event.toolName ?? 'tool',
          detail: event.content,
          status:
            event.toolStatus === 'error'
              ? 'error'
              : event.toolStatus === 'done'
                ? 'done'
                : 'running',
          timestamp: event.timestamp,
        });
      }
    }
    if (event.type === 'trace') {
      this.applyTraceEvent(runtime, event);
    }
    if (event.type === 'status') {
      task.status = event.status;
      task.error = event.error;
      if (event.status === 'running') {
        runtime.activeRunId = `agent-run-${Date.now()}`;
        runtime.trace.set(runtime.activeRunId, {
          id: runtime.activeRunId,
          type: 'model',
          title: `${task.runtime?.runtimeId ?? 'pi'} run`,
          status: 'running',
          timestamp: Date.now(),
        });
      } else if (runtime.activeRunId) {
        const trace = runtime.trace.get(runtime.activeRunId);
        if (trace) {
          trace.status = event.status === 'error' ? 'error' : 'done';
          trace.durationMs = Date.now() - trace.timestamp;
        }
        runtime.activeRunId = undefined;
      }
    }
    if (event.type === 'session') {
      task.runtime = event.session;
      task.sessionFile = event.session.sessionFile;
      task.model = event.model ?? task.model;
      task.thinkingLevel = event.thinkingLevel ?? task.thinkingLevel;
    }
    task.updatedAt = Date.now();
    this.persistTask();
    this.persistTrace();
    this.notify();
  }

  /**
   * Trace projection with merge semantics:
   * - model events enrich the synthetic run row, so each round keeps one model
   *   row carrying aggregated tokens/ttft instead of duplicate per-message rows;
   * - same-id events (tool start -> tool result) merge field by field, keeping
   *   the first timestamp so the row keeps its start time.
   */
  private applyTraceEvent(
    runtime: TaskRuntimeState,
    event: Extract<RuntimeEvent, { type: 'trace' }>
  ): void {
    if (event.traceType === 'model' && runtime.activeRunId) {
      const run = runtime.trace.get(runtime.activeRunId);
      if (run) {
        if (event.tokensIn !== undefined) run.tokensIn = (run.tokensIn ?? 0) + event.tokensIn;
        if (event.tokensOut !== undefined) run.tokensOut = (run.tokensOut ?? 0) + event.tokensOut;
        if (event.ttftMs !== undefined) {
          run.ttftMs = Math.min(run.ttftMs ?? event.ttftMs, event.ttftMs);
        }
        if (run.input === undefined && event.input !== undefined) run.input = event.input;
        if (run.output === undefined && event.output !== undefined) run.output = event.output;
        return;
      }
    }
    const previous = runtime.trace.get(event.id);
    const row: TraceEvent = previous
      ? { ...previous }
      : {
          id: event.id,
          type: event.traceType,
          title: event.title,
          status: event.status,
          timestamp: event.timestamp,
        };
    row.type = event.traceType;
    row.title = event.title;
    row.status = event.status;
    if (event.detail !== undefined) row.detail = event.detail;
    if (event.durationMs !== undefined) row.durationMs = event.durationMs;
    if (event.tokensIn !== undefined) row.tokensIn = event.tokensIn;
    if (event.tokensOut !== undefined) row.tokensOut = event.tokensOut;
    if (event.input !== undefined) row.input = event.input;
    if (event.output !== undefined) row.output = event.output;
    if (event.ttftMs !== undefined) row.ttftMs = event.ttftMs;
    runtime.trace.set(event.id, row);
  }

  private transcriptFrom(event: Extract<RuntimeEvent, { type: 'message' }>): TranscriptItem {
    return {
      id: event.id,
      kind: event.role,
      content: event.content,
      timestamp: event.timestamp,
      toolName: event.toolName,
      toolStatus: event.toolStatus,
    };
  }

  private persistTask(): void {
    this.deps.persistence.saveTask(this.task);
  }

  private persistTrace(): void {
    if (!this.runtime) return;
    this.deps.persistence.saveTrace(
      this.task.id,
      [...this.runtime.trace.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-500)
    );
  }

  private addErrorTrace(message: string): void {
    if (!this.runtime) return;
    const timestamp = Date.now();
    this.runtime.trace.set(`error-${timestamp}`, {
      id: `error-${timestamp}`,
      type: 'error',
      title: 'Run failed',
      detail: message,
      status: 'error',
      timestamp,
    });
  }

  private notify(): void {
    const detail = this.getState();
    for (const listener of this.listeners) listener(detail);
  }

  /** Wire-compatible empty projection for lazy switch/reconfigure broadcasts (P1). */
  private notifyEmpty(): void {
    const detail: TaskDetail = { ...this.task, messages: [], trace: [] };
    for (const listener of this.listeners) listener(detail);
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
