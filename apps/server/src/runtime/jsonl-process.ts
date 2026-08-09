import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;

type ProcessLauncher = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: ['pipe', 'pipe', 'pipe'];
  }
) => ChildProcessWithoutNullStreams;

export interface JsonlProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  launch?: ProcessLauncher;
}

export class JsonlProcess {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly listeners = new Set<(record: unknown) => void>();
  private readonly exitListeners = new Set<(error?: Error) => void>();
  private stderr = '';

  constructor(private readonly options: JsonlProcessOptions) {}

  async start(): Promise<void> {
    if (this.process) return;
    const launch = this.options.launch ?? (spawn as ProcessLauncher);
    const child = launch(this.options.executable, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    this.attachReader(child);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-MAX_STDERR_CHARS);
    });
    child.once('exit', code => {
      if (this.process !== child) return;
      this.process = null;
      const error =
        code === 0 ? undefined : new Error(this.stderr || `Runtime exited with code ${code}`);
      for (const listener of this.exitListeners) listener(error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      if (this.process === child) this.process = null;
      child.kill('SIGTERM');
      throw error;
    }
  }

  send(record: unknown): void {
    if (!this.process?.stdin.writable) throw new Error('Runtime process is not running');
    this.process.stdin.write(`${JSON.stringify(record)}\n`);
  }

  onRecord(listener: (record: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (!child) return;
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private attachReader(child: ChildProcessWithoutNullStreams): void {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    const consume = (): void => {
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) continue;
        if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
          child.kill('SIGTERM');
          return;
        }
        try {
          const record: unknown = JSON.parse(line);
          for (const listener of this.listeners) listener(record);
        } catch {
          // Ignore malformed stdout records; protocol clients can time out their pending request.
        }
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RECORD_BYTES) child.kill('SIGTERM');
    };
    child.stdout.on('data', chunk => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      consume();
    });
    child.stdout.on('end', () => {
      buffer += decoder.end();
      consume();
    });
  }
}
