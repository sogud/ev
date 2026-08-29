import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import path from 'node:path';
import {
  BrowserControlRequestSchema,
  BrowserControlResponseSchema,
  type BrowserCommand,
  type BrowserControlResponse,
} from '@ev/contracts';

const MAX_REQUEST_BYTES = 1024 * 1024;

interface BrowserCommandSender {
  sendCommand(command: BrowserCommand): Promise<unknown>;
}

interface BrowserPairingControl {
  getSnapshot(): unknown;
  approvePendingPairing(browserId: string): unknown;
  rejectPendingPairing(browserId: string): unknown;
}

interface BrowserControlServerOptions {
  runtimeDirectory: string;
  token?: string;
  hostKind?: 'desktop' | 'standalone';
  onShutdown?: () => void;
}

export interface BrowserControlServerSnapshot {
  socketPath: string;
  tokenPath: string;
  discoveryPath: string;
  hostKind: 'desktop' | 'standalone';
  pid: number;
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not connected')) return 'BROWSER_DISCONNECTED';
  if (message.includes('downloads are disabled')) return 'DOWNLOAD_PERMISSION_REQUIRED';
  if (message.includes('local or private network')) return 'DOWNLOAD_BLOCKED';
  if (message.includes('yt-dlp is not installed')) return 'DOWNLOAD_HELPER_UNAVAILABLE';
  if (message.includes('Download not found')) return 'DOWNLOAD_NOT_FOUND';
  if (message.includes('timed out')) return 'TIMEOUT';
  return 'COMMAND_FAILED';
}

export class BrowserControlServer {
  private readonly token: string;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private snapshot: BrowserControlServerSnapshot | null = null;

  constructor(
    private readonly bridge: BrowserCommandSender & Partial<BrowserPairingControl>,
    private readonly options: BrowserControlServerOptions
  ) {
    this.token = options.token ?? randomBytes(32).toString('base64url');
  }

  async start(): Promise<BrowserControlServerSnapshot> {
    if (this.server && this.snapshot) return this.snapshot;

    const runtimeDirectory = this.options.runtimeDirectory;
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await chmod(runtimeDirectory, 0o700);

    const suffix = String(process.pid);
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\ev-browser-${suffix}`
        : path.join(runtimeDirectory, `browser-${suffix}.sock`);
    const tokenPath = path.join(runtimeDirectory, `browser-${suffix}.token`);
    const discoveryPath = path.join(runtimeDirectory, 'browser-control.json');
    const snapshot = {
      socketPath,
      tokenPath,
      discoveryPath,
      hostKind: this.options.hostKind ?? 'desktop',
      pid: process.pid,
    };

    await writeFile(tokenPath, `${this.token}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);

    const server = net.createServer(socket => this.handleConnection(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(socketPath, () => {
          server.off('error', onError);
          resolve();
        });
      });
      if (process.platform !== 'win32') await chmod(socketPath, 0o600);
      await writeFile(
        discoveryPath,
        `${JSON.stringify({
          protocolVersion: 1,
          socketPath,
          tokenPath,
          hostKind: snapshot.hostKind,
          pid: snapshot.pid,
        })}\n`,
        { mode: 0o600 }
      );
      await chmod(discoveryPath, 0o600);
      this.snapshot = snapshot;
      return snapshot;
    } catch (error) {
      this.server = null;
      server.close();
      await this.removeRuntimeFiles(snapshot);
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    const snapshot = this.snapshot;
    this.server = null;
    this.snapshot = null;
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    if (snapshot) await this.removeRuntimeFiles(snapshot);
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let input = '';
    let handled = false;

    const finish = (response: BrowserControlResponse): void => {
      if (handled) return;
      handled = true;
      socket.end(`${JSON.stringify(BrowserControlResponseSchema.parse(response))}\n`);
    };

    socket.on('data', chunk => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
        socket.destroy(new Error('Browser control request exceeds 1 MiB'));
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      void this.handleLine(line).then(finish);
    });
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
  }

  private async handleLine(line: string): Promise<BrowserControlResponse> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      return this.failure(randomUUID(), 'INVALID_REQUEST', 'Request must be one JSON line');
    }

    const requestId =
      decoded &&
      typeof decoded === 'object' &&
      'requestId' in decoded &&
      typeof decoded.requestId === 'string'
        ? decoded.requestId
        : randomUUID();
    const parsed = BrowserControlRequestSchema.safeParse(decoded);
    if (!parsed.success) {
      return this.failure(
        /^[0-9a-f-]{36}$/i.test(requestId) ? requestId : randomUUID(),
        'INVALID_REQUEST',
        'Browser control request failed schema validation'
      );
    }
    if (!tokensMatch(parsed.data.token, this.token)) {
      return this.failure(parsed.data.requestId, 'UNAUTHORIZED', 'Invalid browser control token');
    }

    const command = parsed.data.command;
    if (command.action === 'host.status') {
      return {
        requestId: parsed.data.requestId,
        success: true,
        data: { hostKind: this.options.hostKind ?? 'desktop', pid: process.pid },
      };
    }
    if (command.action === 'host.shutdown') {
      if (this.options.hostKind !== 'standalone' || !this.options.onShutdown) {
        return this.failure(
          parsed.data.requestId,
          'UNSUPPORTED_COMMAND',
          'This Browser Host cannot be stopped through the CLI'
        );
      }
      setTimeout(() => this.options.onShutdown?.(), 10);
      return {
        requestId: parsed.data.requestId,
        success: true,
        data: { stopping: true },
      };
    }

    if (command.action === 'pairing.list') {
      if (!this.bridge.getSnapshot) {
        return this.failure(
          parsed.data.requestId,
          'UNSUPPORTED_COMMAND',
          'Pairing control is unavailable on this Browser Host'
        );
      }
      return { requestId: parsed.data.requestId, success: true, data: this.bridge.getSnapshot() };
    }
    if (command.action === 'pairing.approve' || command.action === 'pairing.reject') {
      const method =
        command.action === 'pairing.approve'
          ? this.bridge.approvePendingPairing
          : this.bridge.rejectPendingPairing;
      if (!method) {
        return this.failure(
          parsed.data.requestId,
          'UNSUPPORTED_COMMAND',
          'Pairing control is unavailable on this Browser Host'
        );
      }
      try {
        const data = method.call(this.bridge, command.browserId);
        return { requestId: parsed.data.requestId, success: true, data };
      } catch (error) {
        return this.failure(
          parsed.data.requestId,
          'PAIRING_FAILED',
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    try {
      const data = await this.bridge.sendCommand(command);
      return { requestId: parsed.data.requestId, success: true, data };
    } catch (error) {
      return this.failure(
        parsed.data.requestId,
        errorCode(error),
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private failure(requestId: string, code: string, message: string): BrowserControlResponse {
    return { requestId, success: false, error: { code, message } };
  }

  private async removeRuntimeFiles(snapshot: BrowserControlServerSnapshot): Promise<void> {
    // The discovery file is shared by every host on this run dir: only remove it
    // when it still points at us, never when another live host re-registered.
    const ownsDiscovery = await readFile(snapshot.discoveryPath, 'utf8')
      .then(raw => (JSON.parse(raw) as { pid?: number }).pid === process.pid)
      .catch(() => false);
    await Promise.all([
      process.platform === 'win32' ? Promise.resolve() : rm(snapshot.socketPath, { force: true }),
      rm(snapshot.tokenPath, { force: true }),
      ownsDiscovery ? rm(snapshot.discoveryPath, { force: true }) : Promise.resolve(),
    ]);
  }
}
