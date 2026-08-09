import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserControlServer } from '../browser-control-server';
import { standaloneBrowserHostIsAvailable, stopStandaloneBrowserHost } from '../host-discovery';

const directories: string[] = [];
const servers: BrowserControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })));
});

describe('standalone Browser Host discovery', () => {
  it('checks and stops the authenticated control socket instead of signaling a PID', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-host-discovery-'));
    directories.push(directory);
    const bridge = { sendCommand: vi.fn() };
    const server = new BrowserControlServer(bridge, {
      runtimeDirectory: directory,
      hostKind: 'standalone',
      onShutdown: () => void server.stop(),
    });
    servers.push(server);
    await server.start();

    expect(await standaloneBrowserHostIsAvailable(directory)).toBe(true);
    expect(await stopStandaloneBrowserHost(directory)).toBe(true);
    expect(await standaloneBrowserHostIsAvailable(directory)).toBe(false);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });
});
