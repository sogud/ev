import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EV_PROTOCOL_VERSION, BrowserControlResponseSchema } from '@ev/contracts';
import { BrowserControlServer } from '../browser-control-server';

async function request(socketPath: string, value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on('data', chunk => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      resolve(JSON.parse(response.slice(0, newline)));
    });
    socket.on('error', reject);
  });
}

describe('BrowserControlServer', () => {
  const servers: BrowserControlServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.stop()));
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })));
  });

  it('authenticates, validates, and forwards one browser command', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-browser-control-'));
    directories.push(directory);
    const token = 't'.repeat(43);
    const bridge = { sendCommand: vi.fn(async command => ({ command, transport: 'cdp' })) };
    const server = new BrowserControlServer(bridge, { runtimeDirectory: directory, token });
    servers.push(server);
    const snapshot = await server.start();
    const requestId = randomUUID();

    const response = await request(snapshot.socketPath, {
      protocolVersion: EV_PROTOCOL_VERSION,
      requestId,
      token,
      command: { action: 'page.snapshot', tabId: 7, mode: 'interactive' },
    });

    expect(BrowserControlResponseSchema.parse(response)).toEqual({
      requestId,
      success: true,
      data: {
        command: { action: 'page.snapshot', tabId: 7, mode: 'interactive' },
        transport: 'cdp',
      },
    });
    expect(bridge.sendCommand).toHaveBeenCalledOnce();
    expect((await readFile(snapshot.tokenPath, 'utf8')).trim()).toBe(token);
  });

  it('authenticates standalone status and shutdown without trusting a PID', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-browser-control-'));
    directories.push(directory);
    const token = 't'.repeat(43);
    const onShutdown = vi.fn();
    const bridge = { sendCommand: vi.fn() };
    const server = new BrowserControlServer(bridge, {
      runtimeDirectory: directory,
      token,
      hostKind: 'standalone',
      onShutdown,
    });
    servers.push(server);
    const snapshot = await server.start();

    const status = BrowserControlResponseSchema.parse(
      await request(snapshot.socketPath, {
        protocolVersion: EV_PROTOCOL_VERSION,
        requestId: randomUUID(),
        token,
        command: { action: 'host.status' },
      })
    );
    expect(status).toMatchObject({
      success: true,
      data: { hostKind: 'standalone', pid: process.pid },
    });

    const shutdown = BrowserControlResponseSchema.parse(
      await request(snapshot.socketPath, {
        protocolVersion: EV_PROTOCOL_VERSION,
        requestId: randomUUID(),
        token,
        command: { action: 'host.shutdown' },
      })
    );
    expect(shutdown).toMatchObject({ success: true, data: { stopping: true } });
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledOnce());
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('rejects an invalid token without forwarding the command', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-browser-control-'));
    directories.push(directory);
    const bridge = { sendCommand: vi.fn() };
    const server = new BrowserControlServer(bridge, {
      runtimeDirectory: directory,
      token: 't'.repeat(43),
    });
    servers.push(server);
    const snapshot = await server.start();
    const requestId = randomUUID();

    const response = BrowserControlResponseSchema.parse(
      await request(snapshot.socketPath, {
        protocolVersion: EV_PROTOCOL_VERSION,
        requestId,
        token: 'x'.repeat(43),
        command: { action: 'tabs.list' },
      })
    );

    expect(response).toEqual({
      requestId,
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid browser control token' },
    });
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('lists, approves, and rejects pairing requests without forwarding a command', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-browser-control-'));
    directories.push(directory);
    const token = 't'.repeat(43);
    const browserId = randomUUID();
    const snapshot = { pendingPairings: [{ browserId }], pairedBrowsers: [] };
    const bridge = {
      sendCommand: vi.fn(),
      getSnapshot: vi.fn(() => snapshot),
      approvePendingPairing: vi.fn(() => snapshot),
      rejectPendingPairing: vi.fn(() => snapshot),
    };
    const server = new BrowserControlServer(bridge, { runtimeDirectory: directory, token });
    servers.push(server);
    const { socketPath } = await server.start();

    for (const command of [
      { action: 'pairing.list' },
      { action: 'pairing.approve', browserId },
      { action: 'pairing.reject', browserId },
    ]) {
      const response = BrowserControlResponseSchema.parse(
        await request(socketPath, {
          protocolVersion: EV_PROTOCOL_VERSION,
          requestId: randomUUID(),
          token,
          command,
        })
      );
      expect(response).toMatchObject({ success: true, data: snapshot });
    }

    expect(bridge.approvePendingPairing).toHaveBeenCalledWith(browserId);
    expect(bridge.rejectPendingPairing).toHaveBeenCalledWith(browserId);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('turns a failed approval into PAIRING_FAILED instead of dropping the request', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-browser-control-'));
    directories.push(directory);
    const token = 't'.repeat(43);
    const bridge = {
      sendCommand: vi.fn(),
      getSnapshot: vi.fn(() => ({ pendingPairings: [], pairedBrowsers: [] })),
      approvePendingPairing: vi.fn(() => {
        throw new Error('No EV Browser pairing request is pending for ghost');
      }),
      rejectPendingPairing: vi.fn(),
    };
    const server = new BrowserControlServer(bridge, { runtimeDirectory: directory, token });
    servers.push(server);
    const { socketPath } = await server.start();

    const response = BrowserControlResponseSchema.parse(
      await request(socketPath, {
        protocolVersion: EV_PROTOCOL_VERSION,
        requestId: randomUUID(),
        token,
        command: { action: 'pairing.approve', browserId: randomUUID() },
      })
    );

    expect(response).toMatchObject({
      success: false,
      error: {
        code: 'PAIRING_FAILED',
        message: 'No EV Browser pairing request is pending for ghost',
      },
    });
  });

  it('refuses pairing control on a host that does not expose it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-browser-control-'));
    directories.push(directory);
    const token = 't'.repeat(43);
    const bridge = { sendCommand: vi.fn() };
    const server = new BrowserControlServer(bridge, { runtimeDirectory: directory, token });
    servers.push(server);
    const { socketPath } = await server.start();

    const response = BrowserControlResponseSchema.parse(
      await request(socketPath, {
        protocolVersion: EV_PROTOCOL_VERSION,
        requestId: randomUUID(),
        token,
        command: { action: 'pairing.approve', browserId: randomUUID() },
      })
    );

    expect(response).toMatchObject({
      success: false,
      error: { code: 'UNSUPPORTED_COMMAND' },
    });
  });
});
