import { JsonlProcess, type JsonlProcessOptions } from './jsonl-process';

/**
 * Deep JSONL-RPC transport: framing lives in JsonlProcess; this module owns the
 * request/response semantics shared by every RPC-speaking adapter — the pending
 * table, per-request timeout, and exit-time bulk reject (previously duplicated
 * in pi-rpc-session and codex-app-server-client). Protocol message shapes stay
 * with the adapters via matchResponse; non-response records pass through to
 * onRecord untouched (event-stream consumers keep working).
 */
export interface RpcResponseMatch {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: Error;
}

export interface JsonlRpcTransportOptions {
  process: JsonlProcessOptions;
  /** Protocol seam: recognize an id-correlated response, or null to pass the record through. */
  matchResponse(record: unknown): RpcResponseMatch | null;
  timeoutMs?: number;
  timeoutMessage?(id: string): string;
  exitMessage?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class JsonlRpcTransport {
  private readonly process: JsonlProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly recordListeners = new Set<(record: unknown) => void>();
  private readonly exitListeners = new Set<(error?: Error) => void>();

  constructor(private readonly options: JsonlRpcTransportOptions) {
    this.process = new JsonlProcess(options.process);
    this.process.onRecord(record => {
      const match = this.options.matchResponse(record);
      if (!match) {
        for (const listener of this.recordListeners) listener(record);
        return;
      }
      const pending = this.pending.get(match.id);
      if (!pending) return;
      this.pending.delete(match.id);
      clearTimeout(pending.timer);
      if (match.ok) pending.resolve(match.value);
      else pending.reject(match.error ?? new Error('RPC request failed'));
    });
    this.process.onExit(error => {
      // centralized exit-reject: every in-flight request fails with the process.
      const failure = error ?? new Error(this.options.exitMessage ?? 'RPC process exited');
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(failure);
      }
      this.pending.clear();
      for (const listener of this.exitListeners) listener(error);
    });
  }

  start(): Promise<void> {
    return this.process.start();
  }

  send(record: unknown): void {
    this.process.send(record);
  }

  onRecord(listener: (record: unknown) => void): () => void {
    this.recordListeners.add(listener);
    return () => {
      this.recordListeners.delete(listener);
    };
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  newId(): string {
    return crypto.randomUUID();
  }

  request(id: string, record: unknown, timeoutLabel?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            this.options.timeoutMessage?.(timeoutLabel ?? id) ??
              `RPC request ${timeoutLabel ?? id} timed out`
          )
        );
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.process.send(record);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async stop(stopMessage = 'RPC transport stopped'): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(stopMessage));
    }
    this.pending.clear();
    await this.process.stop();
  }
}
