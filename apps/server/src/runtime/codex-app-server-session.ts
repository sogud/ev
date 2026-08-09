import type { RuntimeEvent } from '@ev/contracts';
import { RuntimeEventSchema } from '@ev/contracts';
import type { ThinkingLevel } from '@ev/contracts/domain';
import type { CodexAppServerClient } from './codex-app-server-client';
import type { RuntimeSession, RuntimeSessionState } from './runtime-adapter';

const MAX_CONTENT_CHARS = 1024 * 1024;
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/**
 * 纯协议映射：Codex item → RuntimeEvent（照 claude-family mapClaudeFamilyRecord 模式）。
 * 状态机（turn 等待/乱序完成）留在 CodexAppServerSession，本函数可脱离会话单测。
 */
export function mapCodexItem(
  item: UnknownRecord,
  timestamp: number,
  completed: boolean
): RuntimeEvent[] {
  const id = typeof item.id === 'string' ? item.id : `codex-${timestamp}`;
  if (item.type === 'userMessage') {
    const content = Array.isArray(item.content)
      ? item.content
          .filter(isRecord)
          .map(value => value.text)
          .filter((value): value is string => typeof value === 'string')
          .join('\n')
      : '';
    return [codexMessage(id, 'user', content, timestamp)];
  }
  if (item.type === 'agentMessage') {
    return [codexMessage(id, 'assistant', boundedText(item.text), timestamp)];
  }
  if (item.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.join('\n') : '';
    const content = Array.isArray(item.content) ? item.content.join('\n') : '';
    return [codexMessage(id, 'thinking', summary || content, timestamp)];
  }
  if (item.type === 'commandExecution') {
    return [
      codexMessage(id, 'tool', boundedText(item.aggregatedOutput ?? item.command), timestamp, {
        toolName: 'command',
        toolStatus: completed ? (item.status === 'failed' ? 'error' : 'done') : 'running',
      }),
    ];
  }
  if (
    item.type === 'fileChange' ||
    item.type === 'mcpToolCall' ||
    item.type === 'dynamicToolCall'
  ) {
    return [
      codexMessage(id, 'tool', boundedText(item), timestamp, {
        toolName: String(item.type),
        toolStatus: completed ? 'done' : 'running',
      }),
    ];
  }
  return [];
}

function codexMessage(
  id: string,
  role: Extract<RuntimeEvent, { type: 'message' }>['role'],
  content: string,
  timestamp: number,
  extra: { toolName?: string; toolStatus?: 'running' | 'done' | 'error' } = {}
): RuntimeEvent {
  return RuntimeEventSchema.parse({ type: 'message', id, role, content, timestamp, ...extra });
}

function boundedText(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2);
          } catch {
            return String(value);
          }
        })();
  return text.slice(0, MAX_CONTENT_CHARS);
}

export class CodexAppServerSession implements RuntimeSession {
  readonly runtimeId = 'codex' as const;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly events = new Map<string, RuntimeEvent>();
  private readonly turnWaiters = new Map<string, { resolve(): void; reject(error: Error): void }>();
  private readonly completedTurns = new Map<string, Error | null>();
  private state: RuntimeSessionState;
  private activeTurnId: string | null = null;
  private startingTurn: Promise<string> | null = null;
  private modelId?: string;
  private needsResume = false;
  private disposing = false;
  private unsubscribe: () => void;
  private unsubscribeExit: () => void;

  constructor(
    private readonly client: CodexAppServerClient,
    thread: UnknownRecord,
    options: { model?: string; modelProvider?: string; thinkingLevel?: ThinkingLevel } = {}
  ) {
    if (typeof thread.id !== 'string') throw new Error('Codex thread has no id');
    const sessionFile = typeof thread.path === 'string' ? thread.path : undefined;
    this.state = {
      ref: {
        runtimeId: 'codex',
        nativeId: thread.id,
        ...(sessionFile ? { sessionFile } : {}),
      },
      status: 'idle',
      model:
        options.model && options.modelProvider
          ? { provider: options.modelProvider, id: options.model, name: options.model }
          : undefined,
      thinkingLevel: options.thinkingLevel,
    };
    this.modelId = options.model;
    this.loadTurns(thread.turns);
    this.unsubscribe = client.onNotification((method, params) =>
      this.handleNotification(method, params)
    );
    this.unsubscribeExit = client.onExit(error => {
      const failure = error ?? new Error('Codex app-server exited unexpectedly');
      for (const waiter of this.turnWaiters.values()) waiter.reject(failure);
      this.turnWaiters.clear();
      this.activeTurnId = null;
      this.needsResume = true;
      this.emitStatus('error', failure.message);
    });
  }

  getState(): RuntimeSessionState {
    return { ...this.state, ref: { ...this.state.ref } };
  }

  getEvents(): RuntimeEvent[] {
    return [...this.events.values()];
  }

  async prompt(text: string): Promise<void> {
    const turnId = await this.startTurn(text);
    this.completedTurns.delete(turnId);
  }

  async promptAndWait(text: string): Promise<void> {
    const turnId = await this.startTurn(text);
    await this.waitForTurn(turnId);
  }

  async abort(): Promise<void> {
    if (!this.activeTurnId) return;
    await this.client.request('turn/interrupt', {
      threadId: this.state.ref.nativeId,
      turnId: this.activeTurnId,
    });
  }

  async setModel(_provider: string, modelId: string): Promise<void> {
    this.modelId = modelId;
    this.state.model = { provider: 'openai', id: modelId, name: modelId };
    this.emitSession();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.state.thinkingLevel = level;
    this.emitSession();
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    await this.startingTurn?.catch(() => undefined);
    const activeTurnId = this.activeTurnId;
    if (activeTurnId) {
      await this.abort();
      const stopped = await Promise.race([
        this.waitForTurn(activeTurnId).then(
          () => true,
          () => true
        ),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000)),
      ]);
      if (!stopped) throw new Error('Codex turn did not stop within 5 seconds');
    }
    this.unsubscribe();
    this.unsubscribeExit();
    for (const waiter of this.turnWaiters.values())
      waiter.reject(new Error('Codex session disposed'));
    this.turnWaiters.clear();
  }

  private startTurn(text: string): Promise<string> {
    if (this.disposing) return Promise.reject(new Error('Codex session is being disposed'));
    if (this.startingTurn) return Promise.reject(new Error('Codex turn is already starting'));
    const starting = this.performStartTurn(text).finally(() => {
      if (this.startingTurn === starting) this.startingTurn = null;
    });
    this.startingTurn = starting;
    return starting;
  }

  private async performStartTurn(text: string): Promise<string> {
    await this.client.start();
    if (this.needsResume) {
      await this.client.request('thread/resume', {
        threadId: this.state.ref.nativeId,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      });
      this.needsResume = false;
    }
    if (this.activeTurnId && !this.completedTurns.has(this.activeTurnId)) {
      throw new Error('Codex thread already has an active turn');
    }
    const result = await this.client.request('turn/start', {
      threadId: this.state.ref.nativeId,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(this.modelId ? { model: this.modelId } : {}),
      ...(this.state.thinkingLevel ? { effort: this.codexEffort(this.state.thinkingLevel) } : {}),
    });
    if (!isRecord(result) || !isRecord(result.turn) || typeof result.turn.id !== 'string') {
      throw new Error('Codex turn/start returned an invalid turn');
    }
    if (!this.completedTurns.has(result.turn.id)) this.activeTurnId = result.turn.id;
    return result.turn.id;
  }

  private handleNotification(method: string, value: unknown): void {
    if (!isRecord(value) || value.threadId !== this.state.ref.nativeId) return;
    if (method === 'turn/started') {
      const turn = isRecord(value.turn) ? value.turn : undefined;
      if (turn && typeof turn.id === 'string') this.activeTurnId = turn.id;
      this.emitStatus('running');
      return;
    }
    if (method === 'turn/completed') {
      const turn = isRecord(value.turn) ? value.turn : undefined;
      const turnId = turn && typeof turn.id === 'string' ? turn.id : this.activeTurnId;
      const failed = turn?.status === 'failed';
      const error = failed ? new Error(boundedText(turn?.error ?? 'Codex turn failed')) : null;
      if (turnId) {
        this.completedTurns.set(turnId, error);
        const waiter = this.turnWaiters.get(turnId);
        if (waiter) {
          this.turnWaiters.delete(turnId);
          this.completedTurns.delete(turnId);
          if (error) waiter.reject(error);
          else waiter.resolve();
        }
      }
      if (!turnId || this.activeTurnId === turnId) this.activeTurnId = null;
      this.emitStatus(error ? 'error' : 'idle', error?.message);
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (isRecord(value.item)) {
        const timestamp =
          typeof value.startedAtMs === 'number'
            ? value.startedAtMs
            : typeof value.completedAtMs === 'number'
              ? value.completedAtMs
              : Date.now();
        for (const event of mapCodexItem(value.item, timestamp, method === 'item/completed')) {
          this.record(event);
        }
      }
      return;
    }
    if (method === 'item/agentMessage/delta') {
      if (typeof value.itemId !== 'string' || typeof value.delta !== 'string') return;
      const previous = this.events.get(value.itemId);
      const content = `${previous?.type === 'message' ? previous.content : ''}${value.delta}`;
      this.record(codexMessage(value.itemId, 'assistant', content, Date.now()));
      return;
    }
    if (method === 'error') this.emitStatus('error', boundedText(value.error ?? value));
  }

  private waitForTurn(turnId: string): Promise<void> {
    const completed = this.completedTurns.get(turnId);
    if (completed !== undefined) {
      this.completedTurns.delete(turnId);
      return completed ? Promise.reject(completed) : Promise.resolve();
    }
    return new Promise<void>((resolve, reject) =>
      this.turnWaiters.set(turnId, { resolve, reject })
    );
  }

  private loadTurns(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const turn of value) {
      if (!isRecord(turn) || !Array.isArray(turn.items)) continue;
      const timestamp = typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : Date.now();
      for (const item of turn.items) {
        if (!isRecord(item)) continue;
        for (const event of mapCodexItem(item, timestamp, true)) this.record(event);
      }
    }
  }

  private record(event: RuntimeEvent): void {
    if (event.type === 'message') this.events.set(event.id, event);
    for (const listener of this.listeners) listener(event);
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

  /**
   * EV thinkingLevel → Codex effort 映射表（P2 定案）：
   * off/minimal→minimal，low→low，medium→medium，high→high，xhigh→xhigh，max→ultra。
   */
  private codexEffort(level: ThinkingLevel): string {
    if (level === 'off' || level === 'minimal') return 'minimal';
    if (level === 'xhigh') return 'xhigh';
    if (level === 'max') return 'ultra';
    return level;
  }
}
