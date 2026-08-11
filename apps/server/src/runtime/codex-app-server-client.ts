import { JsonlRpcTransport, type RpcResponseMatch } from './jsonl-rpc-transport';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/** Codex protocol seam: id-correlated result/error records settle requests; notifications pass through. */
function codexResponseMatch(value: unknown): RpcResponseMatch | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  if (!('result' in value) && !('error' in value)) return null;
  if (value.error) {
    const message = isRecord(value.error) ? value.error.message : value.error;
    return {
      id: value.id,
      ok: false,
      error: new Error(typeof message === 'string' ? message : 'Codex app-server request failed'),
    };
  }
  return { id: value.id, ok: true, value: value.result };
}

export class CodexAppServerClient {
  private readonly transport: JsonlRpcTransport;
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly exitListeners = new Set<(error?: Error) => void>();
  private started = false;
  private starting: Promise<void> | null = null;
  private stopping = false;

  constructor(options: { executable: string; cwd: string; environment?: NodeJS.ProcessEnv }) {
    this.transport = new JsonlRpcTransport({
      process: {
        executable: options.executable,
        args: ['app-server', '--listen', 'stdio://'],
        cwd: options.cwd,
        env: options.environment,
      },
      matchResponse: codexResponseMatch,
      timeoutMessage: method => `Codex app-server ${method} timed out`,
      exitMessage: 'Codex app-server exited',
    });
    this.transport.onRecord(record => this.handleRecord(record));
    this.transport.onExit(error => {
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
    const id = this.transport.newId();
    return this.transport.request(id, { id, method, params }, method);
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
    this.started = false;
    await this.transport.stop('Codex app-server stopped');
    this.stopping = false;
  }

  private async initialize(): Promise<void> {
    this.stopping = false;
    try {
      await this.transport.start();
      await this.request('initialize', {
        clientInfo: { name: 'ev', title: 'EV', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.transport.send({ method: 'initialized' });
      this.started = true;
    } catch (error) {
      await this.transport.stop();
      this.started = false;
      throw error;
    }
  }

  private handleRecord(value: unknown): void {
    if (!isRecord(value)) return;
    if (typeof value.method === 'string' && !('id' in value)) {
      for (const listener of this.notificationListeners) listener(value.method, value.params);
      return;
    }
    if (
      typeof value.method === 'string' &&
      (typeof value.id === 'string' || typeof value.id === 'number')
    ) {
      this.transport.send({
        id: value.id,
        error: { code: -32_601, message: 'EV does not support this server request' },
      });
    }
  }
}
