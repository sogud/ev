import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  BrowserControlResponseSchema,
  EV_PROTOCOL_VERSION,
  type BrowserControlResponse,
} from '@ev/contracts';

const CONTROL_TIMEOUT_MS = 1_000;
const STOP_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface BrowserHostDiscovery {
  protocolVersion: number;
  socketPath: string;
  tokenPath: string;
  hostKind?: 'desktop' | 'standalone';
  pid?: number;
}

export function browserHostDiscoveryPath(runtimeDirectory: string): string {
  return path.join(runtimeDirectory, 'browser-control.json');
}

export async function readBrowserHostDiscovery(
  runtimeDirectory: string
): Promise<BrowserHostDiscovery | null> {
  try {
    const value = JSON.parse(
      await readFile(browserHostDiscoveryPath(runtimeDirectory), 'utf8')
    ) as BrowserHostDiscovery;
    return typeof value.socketPath === 'string' && typeof value.tokenPath === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}

async function sendHostControl(
  discovery: BrowserHostDiscovery,
  action: 'host.status' | 'host.shutdown'
): Promise<BrowserControlResponse | null> {
  try {
    const token = (await readFile(discovery.tokenPath, 'utf8')).trim();
    const requestId = randomUUID();
    const request = {
      protocolVersion: EV_PROTOCOL_VERSION,
      requestId,
      token,
      command: { action },
    };
    return await new Promise<BrowserControlResponse | null>(resolve => {
      const socket = net.createConnection(discovery.socketPath);
      let input = '';
      let settled = false;
      const finish = (value: BrowserControlResponse | null): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setEncoding('utf8');
      socket.setTimeout(CONTROL_TIMEOUT_MS);
      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on('timeout', () => finish(null));
      socket.on('error', () => finish(null));
      socket.on('data', chunk => {
        input += chunk;
        if (Buffer.byteLength(input, 'utf8') > MAX_RESPONSE_BYTES) return finish(null);
        const newline = input.indexOf('\n');
        if (newline < 0) return;
        try {
          const response = BrowserControlResponseSchema.parse(JSON.parse(input.slice(0, newline)));
          finish(response.requestId === requestId ? response : null);
        } catch {
          finish(null);
        }
      });
    });
  } catch {
    return null;
  }
}

export async function browserHostIsAvailable(
  runtimeDirectory: string,
  discovery?: BrowserHostDiscovery | null
): Promise<boolean> {
  const current = discovery ?? (await readBrowserHostDiscovery(runtimeDirectory));
  if (!current?.hostKind) return false;
  const response = await sendHostControl(current, 'host.status');
  return (
    response?.success === true &&
    typeof response.data === 'object' &&
    response.data !== null &&
    'hostKind' in response.data &&
    response.data.hostKind === current.hostKind
  );
}

export async function standaloneBrowserHostIsAvailable(
  runtimeDirectory: string,
  discovery?: BrowserHostDiscovery | null
): Promise<boolean> {
  const current = discovery ?? (await readBrowserHostDiscovery(runtimeDirectory));
  return (
    current?.hostKind === 'standalone' && (await browserHostIsAvailable(runtimeDirectory, current))
  );
}

export async function removeStaleBrowserHost(
  runtimeDirectory: string,
  discovery: BrowserHostDiscovery
): Promise<void> {
  if (await browserHostIsAvailable(runtimeDirectory, discovery)) return;
  const current = await readBrowserHostDiscovery(runtimeDirectory);
  if (
    !current ||
    current.socketPath !== discovery.socketPath ||
    current.tokenPath !== discovery.tokenPath ||
    (await browserHostIsAvailable(runtimeDirectory, current))
  ) {
    return;
  }
  await Promise.all([
    rm(browserHostDiscoveryPath(runtimeDirectory), { force: true }),
    rm(discovery.tokenPath, { force: true }),
    process.platform === 'win32' ? Promise.resolve() : rm(discovery.socketPath, { force: true }),
  ]);
}

export async function stopStandaloneBrowserHost(runtimeDirectory: string): Promise<boolean> {
  const discovery = await readBrowserHostDiscovery(runtimeDirectory);
  if (
    discovery?.hostKind !== 'standalone' ||
    !(await standaloneBrowserHostIsAvailable(runtimeDirectory, discovery))
  ) {
    return false;
  }
  const response = await sendHostControl(discovery, 'host.shutdown');
  if (!response?.success) return false;

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await standaloneBrowserHostIsAvailable(runtimeDirectory))) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}
