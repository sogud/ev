import { randomUUID } from 'node:crypto';
import { JsonlProcess } from './jsonl-process';

const REQUEST_TIMEOUT_MS = 30_000;

type UnknownRecord = Record<string, unknown>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

export class CodexAppServerClient {
  private readonly process: JsonlProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly exitListeners = new Set<(error?: Error) => void>();
  private started = false;
  private starting: Promise<void> | null = null;
  private stopping = false;

  constructor(options: { executable: string; cwd: string; environment?: NodeJS.ProcessEnv }) {
    this.process = new JsonlProcess({
      executable: options.executable,
      args: ['app-server', '--listen', 'stdio://'],
      cwd: options.cwd,
      env: options.environment,
    });
    this.process.onRecord(record => this.handleRecord(record));
    this.process.onExit(error => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error ?? new Error('Codex app-server exited'));
      }
      this.pending.clear();
      this.started = false;
      if (!this.stopping) {
        const exitError = error ?? new Error('Codex app-server exited unexpectedly');
        for (const listener of this.exitListeners) listener(exitError);
      }
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.starting) return this.starting;
    const starting = this.initialize().finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  request(method: string, params: UnknownRecord = {}): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.process.send({ id, method, params });
    });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.starting?.catch(() => undefined);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server stopped'));
    }
    this.pending.clear();
    this.started = false;
    await this.process.stop();
    this.stopping = false;
  }

  private async initialize(): Promise<void> {
    this.stopping = false;
    try {
      await this.process.start();
      await this.request('initialize', {
        clientInfo: { name: 'ev', title: 'EV', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.process.send({ method: 'initialized' });
      this.started = true;
    } catch (error) {
      await this.process.stop();
      this.started = false;
      throw error;
    }
  }

  private handleRecord(value: unknown): void {
    if (!isRecord(value)) return;
    if (typeof value.id === 'string' && ('result' in value || 'error' in value)) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) {
        const error = isRecord(value.error) ? value.error.message : value.error;
        pending.reject(
          new Error(typeof error === 'string' ? error : 'Codex app-server request failed')
        );
      } else {
        pending.resolve(value.result);
      }
      return;
    }
    if (typeof value.method === 'string' && !('id' in value)) {
      for (const listener of this.notificationListeners) listener(value.method, value.params);
      return;
    }
    if (
      typeof value.method === 'string' &&
      (typeof value.id === 'string' || typeof value.id === 'number')
    ) {
      this.process.send({
        id: value.id,
        error: { code: -32_601, message: 'EV does not support this server request' },
      });
    }
  }
}
