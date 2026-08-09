import { randomUUID } from 'node:crypto';
import { EV_PROTOCOL_VERSION } from '@ev/contracts';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  BrowserBridgeService,
  type BrowserBridgePersistedState,
  type BrowserBridgeStore,
} from '../browser-bridge-service';

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function memoryStore(): BrowserBridgeStore {
  let value: BrowserBridgePersistedState = {
    pairingToken: null,
    allowedOrigin: null,
    browserId: null,
  };
  return {
    get: () => ({ ...value }),
    set: next => {
      value = { ...next };
    },
  };
}

function connect(endpoint: string, origin = EXTENSION_ORIGIN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { headers: { Origin: origin } });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once('message', raw => {
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

function nextClose(socket: WebSocket): Promise<number> {
  return new Promise(resolve => socket.once('close', code => resolve(code)));
}

function pairingRequest(browserId = randomUUID()): object {
  return {
    type: 'bridge.pair.request',
    protocolVersion: EV_PROTOCOL_VERSION,
    browserId,
    browserName: 'Chrome',
    extensionVersion: '1.0.0',
  };
}

function hello(pairingToken: string, browserId = randomUUID()): object {
  return {
    type: 'bridge.hello',
    protocolVersion: EV_PROTOCOL_VERSION,
    browserId,
    browserName: 'Chrome',
    extensionVersion: '1.0.0',
    pairingToken,
  };
}

describe('BrowserBridgeService', () => {
  let service: BrowserBridgeService;

  beforeEach(async () => {
    service = new BrowserBridgeService({ port: 0, store: memoryStore() });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
  });

  test('listens only on the loopback endpoint and creates explicit pairing credentials', () => {
    const initial = service.getSnapshot();
    expect(initial.status).toBe('listening');
    expect(initial.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/browser$/);
    expect(initial.pairingToken).toBeNull();

    const paired = service.createPairing();
    expect(paired.pairingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(paired.pairedOrigin).toBeNull();
  });

  test('holds an automatic pairing request until Desktop approves it', async () => {
    const browserId = randomUUID();
    const socket = await connect(service.getSnapshot().endpoint);
    const pendingMessage = nextMessage(socket);
    socket.send(JSON.stringify(pairingRequest(browserId)));

    expect(await pendingMessage).toEqual({ type: 'bridge.pair.pending' });
    expect(service.getSnapshot()).toMatchObject({
      status: 'listening',
      pendingPairing: {
        browserId,
        browserName: 'Chrome',
        extensionVersion: '1.0.0',
        origin: EXTENSION_ORIGIN,
      },
    });

    const approvedMessage = nextMessage(socket);
    const approved = service.approvePendingPairing();
    expect(approved.pairingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await approvedMessage).toEqual({
      type: 'bridge.pair.approved',
      protocolVersion: EV_PROTOCOL_VERSION,
      pairingToken: approved.pairingToken,
    });
    expect(service.getSnapshot()).toMatchObject({
      status: 'connected',
      browserId,
      pendingPairing: null,
    });
  });

  test('can automatically approve the first extension for a standalone host', async () => {
    await service.stop();
    service = new BrowserBridgeService({
      port: 0,
      store: memoryStore(),
      pairingMode: 'automatic',
      automaticPairingOrigins: [EXTENSION_ORIGIN],
    });
    await service.start();
    const socket = await connect(service.getSnapshot().endpoint);
    const approvedMessage = nextMessage(socket);
    socket.send(JSON.stringify(pairingRequest()));

    expect(await approvedMessage).toMatchObject({
      type: 'bridge.pair.approved',
      protocolVersion: EV_PROTOCOL_VERSION,
    });
    expect(service.getSnapshot()).toMatchObject({
      status: 'connected',
      pairedOrigin: EXTENSION_ORIGIN,
      pendingPairing: null,
    });
  });

  test('rejects an untrusted extension origin in automatic mode', async () => {
    await service.stop();
    service = new BrowserBridgeService({
      port: 0,
      store: memoryStore(),
      pairingMode: 'automatic',
      automaticPairingOrigins: [EXTENSION_ORIGIN],
    });
    await service.start();
    const socket = await connect(service.getSnapshot().endpoint, 'chrome-extension://untrusted');
    const closed = nextClose(socket);
    socket.send(JSON.stringify(pairingRequest()));

    expect(await closed).toBe(1008);
    expect(service.getSnapshot()).toMatchObject({ status: 'listening', pairedOrigin: null });
  });

  test('can reject a pending pairing request', async () => {
    const socket = await connect(service.getSnapshot().endpoint);
    const pendingMessage = nextMessage(socket);
    socket.send(JSON.stringify(pairingRequest()));
    await pendingMessage;
    const closed = nextClose(socket);

    const snapshot = service.rejectPendingPairing();

    expect(await closed).toBe(1008);
    expect(snapshot.pendingPairing).toBeNull();
    expect(snapshot.status).toBe('listening');
  });

  test('rejects non-extension WebSocket origins during upgrade', async () => {
    await expect(connect(service.getSnapshot().endpoint, 'https://example.com')).rejects.toThrow(
      'Unexpected server response: 403'
    );
  });

  test('rejects a client with an invalid token', async () => {
    service.createPairing();
    const socket = await connect(service.getSnapshot().endpoint);
    const closed = nextClose(socket);
    socket.send(JSON.stringify(hello('invalid-pairing-token')));
    expect(await closed).toBe(1008);
    expect(service.getSnapshot().status).toBe('listening');
  });

  test('pairs the first extension origin and answers heartbeats', async () => {
    const pairing = service.createPairing();
    const browserId = randomUUID();
    const socket = await connect(pairing.endpoint);

    const acknowledgement = nextMessage(socket);
    socket.send(JSON.stringify(hello(pairing.pairingToken!, browserId)));
    expect(await acknowledgement).toEqual({
      type: 'bridge.hello.ack',
      protocolVersion: EV_PROTOCOL_VERSION,
    });
    expect(service.getSnapshot()).toMatchObject({
      status: 'connected',
      pairedOrigin: EXTENSION_ORIGIN,
      browserId,
    });

    const pong = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'bridge.ping', timestamp: 1234 }));
    expect(await pong).toEqual({ type: 'bridge.pong', timestamp: 1234 });
  });

  test('can request a connected extension to reconnect', async () => {
    const pairing = service.createPairing();
    const socket = await connect(pairing.endpoint);
    const acknowledgement = nextMessage(socket);
    socket.send(JSON.stringify(hello(pairing.pairingToken!)));
    await acknowledgement;
    const closed = nextClose(socket);

    const snapshot = service.requestReconnect();

    expect(await closed).toBe(4002);
    expect(snapshot.status).toBe('listening');
  });

  test('routes validated commands and correlates the extension response', async () => {
    const pairing = service.createPairing();
    const socket = await connect(pairing.endpoint);
    const acknowledgement = nextMessage(socket);
    socket.send(JSON.stringify(hello(pairing.pairingToken!)));
    await acknowledgement;

    socket.once('message', raw => {
      const command = JSON.parse(raw.toString()) as { id: string };
      socket.send(
        JSON.stringify({
          type: 'browser.response',
          id: command.id,
          success: true,
          data: [{ id: 7, title: 'EV' }],
        })
      );
    });

    await expect(service.sendCommand({ action: 'tabs.list' })).resolves.toEqual([
      { id: 7, title: 'EV' },
    ]);
  });

  test('locks future connections to the paired extension identity', async () => {
    const pairing = service.createPairing();
    const browserId = randomUUID();
    const first = await connect(pairing.endpoint);
    const acknowledgement = nextMessage(first);
    first.send(JSON.stringify(hello(pairing.pairingToken!, browserId)));
    await acknowledgement;
    const firstClosed = nextClose(first);
    first.close();
    await firstClosed;

    const impostor = await connect(pairing.endpoint, 'chrome-extension://otherextensionid');
    const closed = nextClose(impostor);
    impostor.send(JSON.stringify(hello(pairing.pairingToken!, browserId)));
    expect(await closed).toBe(1008);
  });
});
