import type { RuntimeEvent, RuntimeSessionRef } from '@ev/contracts';
import { RuntimeEventSchema } from '@ev/contracts';
import type { ModelRef, ThinkingLevel, TranscriptItem } from '@ev/contracts/domain';
import { normalizeMessage, normalizeToolEvent } from '../transcript';
import { tokenCounts, traceText } from './trace-payload';
import type { JsonlProcessOptions } from './jsonl-process';
import { JsonlRpcTransport, type RpcResponseMatch } from './jsonl-rpc-transport';
import type { RuntimeSession, RuntimeSessionInput, RuntimeSessionState } from './runtime-adapter';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/** Pi protocol seam: {type:'response'} records settle pending requests; all else passes through. */
function piResponseMatch(value: unknown): RpcResponseMatch | null {
  if (!isRecord(value) || value.type !== 'response' || typeof value.id !== 'string') return null;
  if (value.success === false) {
    return {
      id: value.id,
      ok: false,
      error: new Error(typeof value.error === 'string' ? value.error : 'Pi RPC request failed'),
    };
  }
  return { id: value.id, ok: true, value: value.data };
}

function runtimeMessage(item: TranscriptItem): RuntimeEvent {
  return RuntimeEventSchema.parse({
    type: 'message',
    id: item.id,
    role: item.kind,
    content: item.content,
    timestamp: item.timestamp,
    ...(item.toolName ? { toolName: item.toolName } : {}),
    ...(item.toolStatus ? { toolStatus: item.toolStatus } : {}),
  });
}

export class PiRpcSession implements RuntimeSession {
  readonly runtimeId = 'pi' as const;
  private readonly transport: JsonlRpcTransport;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly events = new Map<string, RuntimeEvent>();
  private state: RuntimeSessionState;
  /** Tool execution start times for durationMs on tool_execution_end. */
  private readonly toolStartedAt = new Map<string, number>();
  /** Per-run TTFT tracking: run start and first streamed content. */
  private runStartedAt: number | null = null;
  private firstTokenAt: number | null = null;
  private modelTraceSeq = 0;
  private unsubscribeRecord = (): void => {};
  private unsubscribeExit = (): void => {};
  private disposing = false;

  private constructor(options: JsonlProcessOptions, initialRef: RuntimeSessionRef) {
    this.transport = new JsonlRpcTransport({
      process: options,
      matchResponse: piResponseMatch,
      timeoutMessage: () => 'Pi RPC request timed out',
      exitMessage: 'Pi RPC process exited',
    });
    this.state = { ref: initialRef, status: 'idle' };
  }

  static async create(
    executable: string,
    input: RuntimeSessionInput,
    options: { skillPaths?: string[] } = {}
  ): Promise<PiRpcSession> {
    const args = ['--mode', 'rpc', '--approve'];
    if (input.session?.sessionFile) args.push('--session', input.session.sessionFile);
    if (input.name && !input.session) args.push('--name', input.name);
    for (const skillPath of [...(options.skillPaths ?? []), ...(input.skillPaths ?? [])]) {
      args.push('--skill', skillPath);
    }
    for (const prompt of input.appendSystemPrompts ?? []) {
      args.push('--append-system-prompt', prompt);
    }
    const session = new PiRpcSession(
      {
        executable,
        args,
        cwd: input.cwd,
        env: input.environment,
      },
      input.session ?? { runtimeId: 'pi', nativeId: 'pending' }
    );
    try {
      await session.start(input);
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  getState(): RuntimeSessionState {
    return { ...this.state, ref: { ...this.state.ref } };
  }

  getEvents(): RuntimeEvent[] {
    return [...this.events.values()];
  }

  async prompt(text: string): Promise<void> {
    await this.request('prompt', { message: text });
  }

  async promptAndWait(text: string): Promise<void> {
    let unsubscribe = (): void => {};
    const settled = new Promise<void>((resolve, reject) => {
      unsubscribe = this.subscribe(event => {
        if (event.type !== 'status' || event.status === 'running') return;
        unsubscribe();
        if (event.status === 'error') reject(new Error(event.error ?? 'Pi runtime failed'));
        else resolve();
      });
    });
    try {
      await this.prompt(text);
      await settled;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  async abort(): Promise<void> {
    await this.request('abort');
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const value = await this.request('set_model', { provider, modelId });
    if (isRecord(value)) {
      const model = this.modelFrom(value);
      if (model) this.state.model = model;
    }
    this.emitSession();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.request('set_thinking_level', { level });
    this.state.thinkingLevel = level;
    this.emitSession();
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    if (this.state.status === 'running') {
      await this.abort().catch(() => undefined);
    }
    this.unsubscribeRecord();
    this.unsubscribeExit();
    await this.transport.stop('Pi RPC session disposed');
  }

  private async start(input: RuntimeSessionInput): Promise<void> {
    this.unsubscribeRecord = this.transport.onRecord(record => this.handleRecord(record));
    this.unsubscribeExit = this.transport.onExit(error => {
      if (!this.disposing) {
        this.emitStatus('error', error?.message ?? 'Pi RPC process exited unexpectedly');
      }
    });
    await this.transport.start();
    const state = await this.request('get_state');
    if (!isRecord(state) || typeof state.sessionId !== 'string') {
      throw new Error('Pi RPC returned invalid session state');
    }
    const sessionFile = typeof state.sessionFile === 'string' ? state.sessionFile : undefined;
    this.state.ref = {
      runtimeId: 'pi',
      nativeId: state.sessionId,
      ...(sessionFile ? { sessionFile } : {}),
    };
    this.state.thinkingLevel = this.thinkingLevelFrom(state.thinkingLevel) ?? input.thinkingLevel;
    this.state.model = isRecord(state.model) ? this.modelFrom(state.model) : input.model;

    const history = await this.request('get_messages');
    if (isRecord(history) && Array.isArray(history.messages)) {
      for (const message of history.messages) {
        for (const item of normalizeMessage(message)) this.record(runtimeMessage(item));
      }
    }
    if (!input.session && input.model) await this.setModel(input.model.provider, input.model.id);
    if (!input.session && input.thinkingLevel) await this.setThinkingLevel(input.thinkingLevel);
    this.emitSession();
    this.emitStatus('idle');
  }

  private request(type: string, payload: UnknownRecord = {}): Promise<unknown> {
    const id = this.transport.newId();
    return this.transport.request(id, { id, type, ...payload }, type);
  }

  private handleRecord(value: unknown): void {
    if (!isRecord(value)) return;
    const type = typeof value.type === 'string' ? value.type : '';
    if (type === 'agent_start' || type === 'auto_retry_start') {
      this.runStartedAt = Date.now();
      this.firstTokenAt = null;
      this.emitStatus('running');
    }
    if (type === 'agent_settled') this.emitStatus('idle');
    if (type === 'auto_retry_end' && value.success === false) {
      this.emitStatus('error', String(value.finalError ?? 'Pi retry failed'));
    }
    if (type === 'message_start' || type === 'message_update' || type === 'message_end') {
      if (type !== 'message_end') this.recordFirstToken();
      for (const item of normalizeMessage(value.message)) this.record(runtimeMessage(item));
      if (type === 'message_end' && isRecord(value.message)) this.recordModelUsage(value.message);
    }
    if (
      type === 'tool_execution_start' ||
      type === 'tool_execution_update' ||
      type === 'tool_execution_end'
    ) {
      const item = normalizeToolEvent(value);
      if (item) this.record(runtimeMessage(item));
      this.recordToolTrace(type, value);
    }
  }

  /** First streamed content of a run -> TTFT trace event (merged into the run row). */
  private recordFirstToken(): void {
    if (this.runStartedAt === null || this.firstTokenAt !== null) return;
    this.firstTokenAt = Date.now();
    this.recordTrace({
      id: `pi-model-ttft-${++this.modelTraceSeq}`,
      traceType: 'model',
      title: 'pi model',
      status: 'running',
      timestamp: this.firstTokenAt,
      ttftMs: Math.max(0, this.firstTokenAt - this.runStartedAt),
    });
  }

  /** message_end carries pi usage ({input, output, cacheRead, cacheWrite}); absent usage emits nothing. */
  private recordModelUsage(message: UnknownRecord): void {
    const tokens = tokenCounts(message.usage);
    if (tokens.tokensIn === undefined && tokens.tokensOut === undefined) return;
    this.recordTrace({
      id: `pi-model-usage-${++this.modelTraceSeq}`,
      traceType: 'model',
      title: 'pi model',
      status: 'running',
      timestamp: Date.now(),
      ...tokens,
    });
  }

  /** Tool lifecycle -> same-id trace rows; task-session merges start input with end output. */
  private recordToolTrace(type: string, value: UnknownRecord): void {
    if (typeof value.toolCallId !== 'string') return;
    const id = `tool-${value.toolCallId}`;
    const timestamp = Date.now();
    if (type === 'tool_execution_start') {
      this.toolStartedAt.set(value.toolCallId, timestamp);
      this.recordTrace({
        id,
        traceType: 'tool',
        title: typeof value.toolName === 'string' ? value.toolName : 'tool',
        status: 'running',
        timestamp,
        ...(value.args !== undefined ? { input: traceText(value.args) } : {}),
      });
      return;
    }
    const startedAt = this.toolStartedAt.get(value.toolCallId);
    const result = value.result ?? value.partialResult;
    const finished = type === 'tool_execution_end';
    this.recordTrace({
      id,
      traceType: 'tool',
      title: typeof value.toolName === 'string' ? value.toolName : 'tool',
      status: finished ? (value.isError === true ? 'error' : 'done') : 'running',
      timestamp: startedAt ?? timestamp,
      ...(finished && startedAt !== undefined
        ? { durationMs: Math.max(0, timestamp - startedAt) }
        : {}),
      ...(result !== undefined ? { output: traceText(result) } : {}),
    });
    if (finished) this.toolStartedAt.delete(value.toolCallId);
  }

  private record(event: RuntimeEvent): void {
    if (event.type === 'message') this.events.set(event.id, event);
    for (const listener of this.listeners) listener(event);
  }

  private recordTrace(event: Omit<Extract<RuntimeEvent, { type: 'trace' }>, 'type'>): void {
    const parsed = RuntimeEventSchema.parse({ type: 'trace', ...event });
    for (const listener of this.listeners) listener(parsed);
  }

  private emitStatus(status: RuntimeSessionState['status'], error?: string): void {
    this.state.status = status;
    this.state.error = error;
    const event = RuntimeEventSchema.parse({ type: 'status', status, ...(error ? { error } : {}) });
    for (const listener of this.listeners) listener(event);
  }

  private emitSession(): void {
    const event = RuntimeEventSchema.parse({
      type: 'session',
      session: this.state.ref,
      ...(this.state.model ? { model: this.state.model } : {}),
      ...(this.state.thinkingLevel ? { thinkingLevel: this.state.thinkingLevel } : {}),
    });
    for (const listener of this.listeners) listener(event);
  }

  private modelFrom(value: UnknownRecord): ModelRef | undefined {
    if (typeof value.provider !== 'string' || typeof value.id !== 'string') return undefined;
    return {
      provider: value.provider,
      id: value.id,
      name: typeof value.name === 'string' ? value.name : value.id,
    };
  }

  private thinkingLevelFrom(value: unknown): ThinkingLevel | undefined {
    return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(value))
      ? (value as ThinkingLevel)
      : undefined;
  }
}
