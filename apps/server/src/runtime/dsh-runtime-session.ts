import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { RuntimeEventSchema, type RuntimeEvent, type RuntimeSessionRef } from '@ev/contracts';
import {
  matchDshResponse,
  parseDshInitializeResult,
  parseDshNotification,
  parseDshPromptResult,
  type DshNotification,
  type DshSessionEvent,
} from './dsh-protocol';
import { JsonlRpcTransport } from './jsonl-rpc-transport';
import { traceText } from './trace-payload';
import type { RuntimeSession, RuntimeSessionInput, RuntimeSessionState } from './runtime-adapter';

const DSH_PROVIDER = 'deepseek-official';
const DSH_MODEL = 'deepseek-v4-flash';
const DSH_SESSION_CLOSED = 'DeepSeek Harness session is closed';
const DSH_STOPPED = 'DeepSeek Harness task was stopped';
const MAX_RUNTIME_CONTENT_CHARS = 16 * 1024 * 1024;
const KNOWN_STREAM_CHUNK_TYPES = new Set([
  'block-start',
  'text-delta',
  'reasoning-delta',
  'tool-call-delta',
  'block-end',
  'usage',
  'finish',
]);
const KNOWN_IGNORED_SESSION_EVENTS = new Set([
  'agent/inbox/spliced',
  'turn/start',
  'step/start',
  'step/end',
  'todo/write',
  'request/header',
  'request/context',
  'session/end-seed',
  'session/title',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
  'compaction/prune',
  'llm/retry',
  'llm/retry-started',
  'subagent/descriptor',
  'plan/mode',
  'tool/code-dispatch-start',
  'tool/code-dispatch',
]);

export interface DshRuntimeLaunch {
  executable: string;
  configPath: string;
  environment: NodeJS.ProcessEnv;
}

interface DshActivity {
  messageId?: string;
  receiptSeen: boolean;
  failure?: Error;
  readonly records: DshNotification[];
  readonly completion: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

export class DshRuntimeSession implements RuntimeSession {
  readonly runtimeId = 'dsh' as const;
  private readonly ref: RuntimeSessionRef;
  private readonly transport: JsonlRpcTransport;
  private readonly events: RuntimeEvent[] = [];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly assistantText = new Map<string, string>();
  private readonly reasoningText = new Map<string, string>();
  private readonly toolNames = new Map<string, string>();
  private readonly descendantSessions = new Set<string>();
  private readonly subagentStartedAt = new Map<string, number>();
  private active: DshActivity | undefined;
  private status: RuntimeSessionState['status'] = 'idle';
  private error: string | undefined;
  private started = false;
  private closing = false;
  private closed = false;
  private terminationTask: Promise<void> | undefined;

  private constructor(
    launch: DshRuntimeLaunch,
    private readonly input: RuntimeSessionInput
  ) {
    this.ref = {
      runtimeId: this.runtimeId,
      nativeId: `session-${randomUUID().replaceAll('-', '')}`,
    };
    const dshHome = launch.environment.DSH_HOME?.trim()
      ? path.resolve(launch.environment.DSH_HOME)
      : path.join(launch.environment.HOME ?? process.env.HOME ?? process.cwd(), '.dsh');
    const sessionRoot = launch.environment.DSH_SESSION_ROOT?.trim()
      ? path.resolve(launch.environment.DSH_SESSION_ROOT)
      : path.join(dshHome, 'sessions');
    this.transport = new JsonlRpcTransport({
      process: {
        executable: launch.executable,
        args: [launch.configPath],
        cwd: input.cwd,
        env: {
          ...launch.environment,
          DSH_CWD: input.cwd,
          DSH_SESSION_ROOT: sessionRoot,
        },
      },
      matchResponse: matchDshResponse,
      timeoutMs: 5_000,
      timeoutMessage: method => `DeepSeek Harness ${method} request timed out`,
      exitMessage: 'DeepSeek Harness runtime exited',
    });
    this.transport.onRecord(record => this.handleRecord(record));
    this.transport.onExit(error => this.handleExit(error));
    this.emit({
      type: 'session',
      session: this.ref,
      model: { provider: DSH_PROVIDER, id: DSH_MODEL, name: 'DeepSeek-V4-Flash' },
    });
  }

  static async create(
    launch: DshRuntimeLaunch,
    input: RuntimeSessionInput
  ): Promise<DshRuntimeSession> {
    const session = new DshRuntimeSession(launch, input);
    try {
      await session.start();
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  getState(): RuntimeSessionState {
    return {
      ref: this.ref,
      status: this.status,
      model: { provider: DSH_PROVIDER, id: DSH_MODEL, name: 'DeepSeek-V4-Flash' },
      ...(this.error ? { error: this.error } : {}),
    };
  }

  getEvents(): RuntimeEvent[] {
    return [...this.events];
  }

  async prompt(text: string): Promise<void> {
    const activity = await this.submit(text);
    void activity.completion.catch(() => undefined);
  }

  async promptAndWait(text: string): Promise<void> {
    const activity = await this.submit(text);
    await activity.completion;
  }

  abort(): Promise<void> {
    return this.close(true, DSH_STOPPED);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): Promise<void> {
    return this.close(false, DSH_SESSION_CLOSED);
  }

  private async start(): Promise<void> {
    await this.transport.start();
    const result = await this.request('initialize', {
      cwd: this.input.cwd,
      provider: DSH_PROVIDER,
      model: DSH_MODEL,
    });
    parseDshInitializeResult(result);
    this.started = true;
  }

  private async submit(text: string): Promise<DshActivity> {
    if (this.closed) throw new Error(this.error ?? DSH_SESSION_CLOSED);
    if (this.active) throw new Error('DeepSeek Harness session already has an active prompt');
    const content = text.trim();
    if (!content) throw new Error('DeepSeek Harness prompt cannot be empty');
    const activity = this.createActivity();
    this.active = activity;
    try {
      const result = parseDshPromptResult(
        await this.request('session/prompt', {
          sessionId: this.ref.nativeId,
          contentBlocks: [{ type: 'text', text: content }],
        })
      );
      activity.messageId = result.messageId;
      for (const notification of activity.records) this.observeActivity(activity, notification);
      return activity;
    } catch (error) {
      const failure = asError(error);
      this.failActivity(activity, failure);
      this.fail(failure);
      throw failure;
    }
  }

  private createActivity(): DshActivity {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    void completion.catch(() => undefined);
    return { receiptSeen: false, records: [], completion, resolve, reject };
  }

  private request(method: string, params?: object): Promise<unknown> {
    const id = this.transport.newId();
    return this.transport.request(
      id,
      { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) },
      method
    );
  }

  private handleRecord(record: unknown): void {
    if (this.closing) return;
    let notification: DshNotification;
    try {
      notification = parseDshNotification(record);
    } catch {
      this.terminateProtocol(new Error('DeepSeek Harness sent an invalid JSON-RPC notification'));
      return;
    }
    const activity = this.active;
    if (activity) activity.records.push(notification);
    try {
      this.projectNotification(notification);
      if (activity?.messageId) this.observeActivity(activity, notification);
    } catch (error) {
      this.terminateProtocol(asError(error));
    }
  }

  private observeActivity(activity: DshActivity, notification: DshNotification): void {
    if (this.active !== activity || !activity.messageId) return;
    if (
      notification.method === 'session.event' &&
      notification.params.sessionId === this.ref.nativeId &&
      isInboxReceipt(notification.params.event, activity.messageId)
    ) {
      activity.receiptSeen = true;
      return;
    }
    if (
      activity.receiptSeen &&
      notification.method === 'session.status' &&
      notification.params.sessionId === this.ref.nativeId &&
      notification.params.status === 'idle'
    ) {
      this.active = undefined;
      if (activity.failure) activity.reject(activity.failure);
      else activity.resolve();
    }
  }

  private projectNotification(notification: DshNotification): void {
    if (notification.method === 'session.status') {
      if (notification.params.sessionId !== this.ref.nativeId) return;
      if (notification.params.status === 'idle' && this.active?.failure) return;
      this.status = notification.params.status;
      this.error = undefined;
      this.emit({ type: 'status', status: notification.params.status });
      return;
    }
    if (notification.method === 'subagent.started') {
      const { parentSessionId, childSessionId } = notification.params;
      if (parentSessionId !== this.ref.nativeId && !this.descendantSessions.has(parentSessionId)) {
        return;
      }
      this.descendantSessions.add(childSessionId);
      const timestamp = Date.now();
      this.subagentStartedAt.set(childSessionId, timestamp);
      this.emit({
        type: 'trace',
        id: `dsh:subagent:${childSessionId}`,
        traceType: 'tool',
        title: 'DSH subagent',
        detail: childSessionId,
        status: 'running',
        timestamp,
      });
      return;
    }
    if (notification.method === 'subagent.finished') {
      const { childSessionId, provider, status } = notification.params;
      if (!this.descendantSessions.has(childSessionId)) return;
      const timestamp = this.subagentStartedAt.get(childSessionId) ?? Date.now();
      const durationMs = Math.max(0, Date.now() - timestamp);
      this.emit({
        type: 'trace',
        id: `dsh:subagent:${childSessionId}`,
        traceType: 'tool',
        title: 'DSH subagent',
        detail: `${provider}: ${childSessionId}`,
        status: status === 'ok' ? 'done' : 'error',
        timestamp,
        durationMs,
      });
      return;
    }
    if (
      notification.method !== 'session.event' ||
      notification.params.sessionId !== this.ref.nativeId
    ) {
      return;
    }
    this.projectSessionEvent(notification.params.event);
  }

  private projectSessionEvent(event: DshSessionEvent): void {
    if (event.type === 'user/message') {
      const data = requireRecord(event.data, 'user/message data');
      const id = requireString(data.id, 'user/message id');
      const content = requireContentText(data.content, 'user/message content');
      if (content) {
        this.emit({ type: 'message', id, role: 'user', content, timestamp: event.time });
      }
      return;
    }
    if (event.type === 'assistant/chunk') {
      const data = requireRecord(event.data, 'assistant/chunk data');
      const turn = requireInteger(data.turn, 'assistant/chunk turn');
      const step = requireInteger(data.step, 'assistant/chunk step');
      const chunk = requireRecord(data.chunk, 'assistant/chunk chunk');
      const chunkType = requireString(chunk.type, 'assistant/chunk type');
      if (!KNOWN_STREAM_CHUNK_TYPES.has(chunkType)) {
        throw new Error(`DeepSeek Harness sent an unknown stream chunk: ${chunkType}`);
      }
      if (chunkType !== 'text-delta' && chunkType !== 'reasoning-delta') return;
      const delta = requireStringValue(chunk.text, `assistant/chunk ${chunkType} text`);
      const thinking = chunkType === 'reasoning-delta';
      const id = `dsh:${thinking ? 'thinking' : 'assistant'}:${turn}:${step}`;
      const content = appendBounded(
        thinking ? this.reasoningText.get(id) : this.assistantText.get(id),
        delta
      );
      (thinking ? this.reasoningText : this.assistantText).set(id, content);
      this.emit({
        type: 'message',
        id,
        role: thinking ? 'thinking' : 'assistant',
        content,
        timestamp: event.time,
      });
      return;
    }
    if (event.type === 'assistant/message') {
      const data = requireRecord(event.data, 'assistant/message data');
      const turn = requireInteger(data.turn, 'assistant/message turn');
      const step = requireInteger(data.step, 'assistant/message step');
      const message = requireRecord(data.message, 'assistant/message message');
      const content = requireContentText(message.content, 'assistant/message content');
      if (!content) return;
      const id = `dsh:assistant:${turn}:${step}`;
      this.assistantText.set(id, content);
      this.emit({ type: 'message', id, role: 'assistant', content, timestamp: event.time });
      return;
    }
    if (event.type === 'tool/call') {
      const data = requireRecord(event.data, 'tool/call data');
      const callId = requireString(data.callId, 'tool/call callId');
      const name = requireString(data.name, 'tool/call name');
      const argumentsText = requireStringValue(data.arguments, 'tool/call arguments');
      this.toolNames.set(callId, name);
      this.emit({
        type: 'message',
        id: `dsh:tool:${callId}`,
        role: 'tool',
        content: argumentsText,
        timestamp: event.time,
        toolName: name,
        toolStatus: 'running',
      });
      this.emit({
        type: 'trace',
        id: `dsh:tool:${callId}`,
        traceType: 'tool',
        title: name,
        status: 'running',
        timestamp: event.time,
        input: traceText(argumentsText),
      });
      return;
    }
    if (event.type === 'tool/result') {
      const data = requireRecord(event.data, 'tool/result data');
      const message = requireRecord(data.message, 'tool/result message');
      if (!Array.isArray(message.content)) {
        throw new Error('DeepSeek Harness sent invalid tool/result content');
      }
      const resultBlock = message.content
        .map(block => recordOf(block))
        .find(block => block?.type === 'tool-result');
      if (!resultBlock) throw new Error('DeepSeek Harness sent tool/result without a result block');
      const callId = requireString(resultBlock.toolCallId, 'tool/result callId');
      const failed = resultBlock.isError === true || data.error !== undefined;
      const content = requireContentText(resultBlock.content, 'tool/result block content');
      const text = content || (failed ? 'Tool failed' : 'Tool completed');
      this.emit({
        type: 'message',
        id: `dsh:tool:${callId}`,
        role: 'tool',
        content: text,
        timestamp: event.time,
        toolName: this.toolNames.get(callId) ?? 'tool',
        toolStatus: failed ? 'error' : 'done',
      });
      this.emit({
        type: 'trace',
        id: `dsh:tool:${callId}`,
        traceType: 'tool',
        title: this.toolNames.get(callId) ?? 'tool',
        status: failed ? 'error' : 'done',
        timestamp: event.time,
        output: traceText(text),
      });
      return;
    }
    if (event.type === 'turn/end') {
      const failure = turnFailure(event.data);
      if (!failure) return;
      if (this.active) this.active.failure = failure;
      this.emit({
        type: 'message',
        id: `dsh:turn:${event.seq}:error`,
        role: 'error',
        content: failure.message,
        timestamp: event.time,
      });
      this.fail(failure);
      return;
    }
    if (KNOWN_IGNORED_SESSION_EVENTS.has(event.type) || event.ignorable === true) return;
    throw new Error(`DeepSeek Harness sent an unknown required session event: ${event.type}`);
  }

  private handleExit(error?: Error): void {
    if (this.closing) return;
    this.closed = true;
    const failure = error ?? new Error('DeepSeek Harness runtime exited unexpectedly');
    const activity = this.active;
    if (activity) this.failActivity(activity, failure);
    this.fail(failure);
  }

  private terminateProtocol(error: Error): void {
    if (this.closed || this.closing) return;
    this.closed = true;
    this.closing = true;
    const activity = this.active;
    if (activity) this.failActivity(activity, error);
    this.fail(error);
    this.terminationTask = this.transport.stop(error.message);
  }

  private fail(error: Error): void {
    const message = boundedString(error.message, 10_000);
    this.status = 'error';
    this.error = message;
    this.emit({ type: 'status', status: 'error', error: message });
  }

  private failActivity(activity: DshActivity, error: Error): void {
    if (this.active === activity) this.active = undefined;
    activity.reject(error);
  }

  private close(emitStopped: boolean, reason: string): Promise<void> {
    if (!this.terminationTask) {
      this.closed = true;
      this.closing = true;
      const activity = this.active;
      if (activity) this.failActivity(activity, new Error(reason));
      this.terminationTask = this.shutdownAndStop(reason);
    }
    if (emitStopped && this.error !== DSH_STOPPED) this.fail(new Error(DSH_STOPPED));
    return this.terminationTask;
  }

  private async shutdownAndStop(reason: string): Promise<void> {
    if (this.started) {
      try {
        await this.request('shutdown');
      } catch {
        // The bounded process stop below remains authoritative.
      }
    }
    await this.transport.stop(reason);
  }

  private emit(event: RuntimeEvent): void {
    const parsed = RuntimeEventSchema.parse(event);
    this.events.push(parsed);
    for (const listener of this.listeners) listener(parsed);
  }
}

function isInboxReceipt(event: DshSessionEvent, messageId: string): boolean {
  if (event.type !== 'agent/inbox/spliced') return false;
  const data = recordOf(event.data);
  return (
    Array.isArray(data?.inserted) &&
    data.inserted.some(message => recordOf(message)?.id === messageId)
  );
}

function requireContentText(value: unknown, label: string): string {
  if (!Array.isArray(value)) throw new Error(`DeepSeek Harness sent invalid ${label}`);
  let content = '';
  for (const block of value) {
    const record = requireRecord(block, `${label} block`);
    const type = requireString(record.type, `${label} block type`);
    if (type === 'text') {
      content = appendBounded(content, requireStringValue(record.text, `${label} text`));
    }
  }
  return content;
}

function appendBounded(current: string | undefined, delta: string): string {
  const content = `${current ?? ''}${delta}`;
  if (content.length > MAX_RUNTIME_CONTENT_CHARS) {
    throw new Error('DeepSeek Harness streamed content beyond the EV Runtime limit');
  }
  return content;
}

function turnFailure(value: unknown): Error | undefined {
  const data = requireRecord(value, 'turn/end data');
  const reason = requireRecord(data.reason, 'turn/end reason');
  const kind = requireString(reason.kind, 'turn/end reason kind');
  if (kind !== 'error') return undefined;
  const failure = requireRecord(reason.error, 'turn/end error');
  const message = requireStringValue(failure.message, 'turn/end error message');
  const code = typeof failure.code === 'string' && failure.code ? failure.code : undefined;
  return new Error(boundedString(code ? `${code}: ${message}` : message, 10_000));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = recordOf(value);
  if (!record) throw new Error(`DeepSeek Harness sent invalid ${label}`);
  return record;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireString(value: unknown, label: string): string {
  const result = requireStringValue(value, label);
  if (!result.trim()) throw new Error(`DeepSeek Harness sent empty ${label}`);
  return result;
}

function requireStringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`DeepSeek Harness sent invalid ${label}`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`DeepSeek Harness sent invalid ${label}`);
  }
  return value as number;
}

function boundedString(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
