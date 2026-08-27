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
const SECOND_EXTENSION_ORIGIN = 'chrome-extension://zyxwvutsrqponmlkjihgfedcbazyxwvuts';

interface MemoryStoreHandle {
  store: BrowserBridgeStore;
  state(): BrowserBridgePersistedState;
}

function memoryStore(): MemoryStoreHandle {
  let value: BrowserBridgePersistedState = { identities: [] };
  return {
    store: {
      get: () => ({ identities: value.identities.map(identity => ({ ...identity })) }),
      set: next => {
        value = { identities: next.identities.map(identity => ({ ...identity })) };
      },
    },
    state: () => value,
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

function pairingRequest(browserId: string = randomUUID(), browserName = 'Chrome'): object {
  return {
    type: 'bridge.pair.request',
    protocolVersion: EV_PROTOCOL_VERSION,
    browserId,
    browserName,
    extensionVersion: '1.0.0',
  };
}

function hello(pairingToken: string, browserId: string = randomUUID()): object {
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
  let handle: MemoryStoreHandle;
  let service: BrowserBridgeService;

  beforeEach(async () => {
    handle = memoryStore();
    service = new BrowserBridgeService({ port: 0, store: handle.store });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
  });

  test('listens only on the loopback endpoint and creates explicit pairing credentials', () => {
    const initial = service.getSnapshot();
    expect(initial.status).toBe('listening');
    expect(initial.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/browser$/);
    expect(initial.pairedBrowsers).toEqual([]);

    service.createPairing();
    const identities = handle.state().identities;
    expect(identities).toHaveLength(1);
    expect(identities[0].pairingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(identities[0].allowedOrigin).toBeNull();
  });

  test('holds an automatic pairing request until Desktop approves it', async () => {
    const browserId = randomUUID();
    const socket = await connect(service.getSnapshot().endpoint);
    const pendingMessage = nextMessage(socket);
    socket.send(JSON.stringify(pairingRequest(browserId)));

    expect(await pendingMessage).toEqual({ type: 'bridge.pair.pending' });
    expect(service.getSnapshot()).toMatchObject({
      status: 'listening',
      pendingPairings: [
        {
          browserId,
          browserName: 'Chrome',
          extensionVersion: '1.0.0',
          origin: EXTENSION_ORIGIN,
        },
      ],
    });

    const approvedMessage = nextMessage(socket);
    service.approvePendingPairing(browserId);
    const approved = (await approvedMessage) as { type: string; pairingToken: string };
    expect(approved).toMatchObject({
      type: 'bridge.pair.approved',
      protocolVersion: EV_PROTOCOL_VERSION,
    });
    expect(approved.pairingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(service.getSnapshot()).toMatchObject({
      status: 'connected',
      pairedBrowsers: [{ browserId, origin: EXTENSION_ORIGIN, online: true }],
      pendingPairings: [],
    });
  });

  test('can automatically approve the first extension for a standalone host', async () => {
    await service.stop();
    service = new BrowserBridgeService({
      port: 0,
      store: handle.store,
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
      pairedBrowsers: [{ origin: EXTENSION_ORIGIN, online: true }],
      pendingPairings: [],
    });
  });

  test('automatic mode without an allowlist trusts genuine extension origins', async () => {
    await service.stop();
    service = new BrowserBridgeService({ port: 0, store: handle.store, pairingMode: 'automatic' });
    await service.start();

    // a web page origin is rejected at the upgrade gate, even on loopback
    await expect(
      connect(service.getSnapshot().endpoint, 'https://evil.example')
    ).rejects.toBeDefined();

    // the genuine extension pairs without any approval click
    const socket = await connect(service.getSnapshot().endpoint);
    const approvedMessage = nextMessage(socket);
    socket.send(JSON.stringify(pairingRequest()));
    expect(await approvedMessage).toMatchObject({ type: 'bridge.pair.approved' });
    expect(service.getSnapshot()).toMatchObject({
      status: 'connected',
      pairedBrowsers: [{ origin: EXTENSION_ORIGIN, online: true }],
    });
  });

  test('rejects an untrusted extension origin in automatic mode', async () => {
    await service.stop();
    service = new BrowserBridgeService({
      port: 0,
      store: handle.store,
      pairingMode: 'automatic',
      automaticPairingOrigins: [EXTENSION_ORIGIN],
    });
    await service.start();
    const socket = await connect(service.getSnapshot().endpoint, 'chrome-extension://untrusted');
    const closed = nextClose(socket);
    socket.send(JSON.stringify(pairingRequest()));

    expect(await closed).toBe(1008);
    expect(service.getSnapshot()).toMatchObject({ status: 'listening', pairedBrowsers: [] });
  });

  test('can reject a pending pairing request', async () => {
    const browserId = randomUUID();
    const socket = await connect(service.getSnapshot().endpoint);
    const pendingMessage = nextMessage(socket);
    socket.send(JSON.stringify(pairingRequest(browserId)));
    await pendingMessage;
    const closed = nextClose(socket);

    const snapshot = service.rejectPendingPairing(browserId);

    expect(await closed).toBe(1008);
    expect(snapshot.pendingPairings).toEqual([]);
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
    service.createPairing();
    const pairingToken = handle.state().identities[0].pairingToken;
    const browserId = randomUUID();
    const socket = await connect(service.getSnapshot().endpoint);

    const acknowledgement = nextMessage(socket);
    socket.send(JSON.stringify(hello(pairingToken, browserId)));
    expect(await acknowledgement).toEqual({
      type: 'bridge.hello.ack',
      protocolVersion: EV_PROTOCOL_VERSION,
    });
    expect(service.getSnapshot()).toMatchObject({
      status: 'connected',
      pairedBrowsers: [{ browserId, origin: EXTENSION_ORIGIN, online: true }],
    });

    const pong = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'bridge.ping', timestamp: 1234 }));
    expect(await pong).toEqual({ type: 'bridge.pong', timestamp: 1234 });
  });

  test('can request a connected extension to reconnect', async () => {
    service.createPairing();
    const pairingToken = handle.state().identities[0].pairingToken;
    const socket = await connect(service.getSnapshot().endpoint);
    const acknowledgement = nextMessage(socket);
    socket.send(JSON.stringify(hello(pairingToken)));
    await acknowledgement;
    const closed = nextClose(socket);

    const snapshot = service.requestReconnect();

    expect(await closed).toBe(4002);
    expect(snapshot.status).toBe('listening');
  });

  test('routes validated commands and correlates the extension response', async () => {
    service.createPairing();
    const pairingToken = handle.state().identities[0].pairingToken;
    const socket = await connect(service.getSnapshot().endpoint);
    const acknowledgement = nextMessage(socket);
    socket.send(JSON.stringify(hello(pairingToken)));
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
    service.createPairing();
    const pairingToken = handle.state().identities[0].pairingToken;
    const browserId = randomUUID();
    const first = await connect(service.getSnapshot().endpoint);
    const acknowledgement = nextMessage(first);
    first.send(JSON.stringify(hello(pairingToken, browserId)));
    await acknowledgement;
    const firstClosed = nextClose(first);
    first.close();
    await firstClosed;

    const impostor = await connect(
      service.getSnapshot().endpoint,
      'chrome-extension://otherextensionid'
    );
    const closed = nextClose(impostor);
    impostor.send(JSON.stringify(hello(pairingToken, browserId)));
    expect(await closed).toBe(1008);
  });

  describe('multiple profiles online at once', () => {
    beforeEach(async () => {
      await service.stop();
      service = new BrowserBridgeService({
        port: 0,
        store: handle.store,
        pairingMode: 'automatic',
        automaticPairingOrigins: [EXTENSION_ORIGIN, SECOND_EXTENSION_ORIGIN],
      });
      await service.start();
    });

    async function pairProfile(
      origin: string,
      browserName: string
    ): Promise<{ socket: WebSocket; browserId: string }> {
      const browserId = randomUUID();
      const socket = await connect(service.getSnapshot().endpoint, origin);
      const approved = nextMessage(socket);
      socket.send(JSON.stringify(pairingRequest(browserId, browserName)));
      await approved;
      return { socket, browserId };
    }

    function autoRespond(socket: WebSocket, data: unknown): void {
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { type: string; id?: string };
        if (message.type !== 'browser.command' || !message.id) return;
        socket.send(
          JSON.stringify({ type: 'browser.response', id: message.id, success: true, data })
        );
      });
    }

    test('keeps several paired browsers connected simultaneously', async () => {
      const work = await pairProfile(EXTENSION_ORIGIN, 'Chrome');
      const personal = await pairProfile(SECOND_EXTENSION_ORIGIN, 'Edge');

      const snapshot = service.getSnapshot();
      expect(snapshot.status).toBe('connected');
      expect(snapshot.pairedBrowsers).toHaveLength(2);
      expect(snapshot.pairedBrowsers.map(browser => browser.browserId).sort()).toEqual(
        [work.browserId, personal.browserId].sort()
      );
      expect(snapshot.pairedBrowsers.every(browser => browser.online)).toBe(true);
    });

    test('requires an explicit browserId when several browsers are connected', async () => {
      const work = await pairProfile(EXTENSION_ORIGIN, 'Chrome');
      const personal = await pairProfile(SECOND_EXTENSION_ORIGIN, 'Edge');
      autoRespond(work.socket, 'work');
      autoRespond(personal.socket, 'personal');

      await expect(service.sendCommand({ action: 'bookmarks.export' })).rejects.toThrow(
        /Multiple EV Browsers are connected/
      );
      await expect(
        service.sendCommand({ action: 'bookmarks.export' }, personal.browserId)
      ).resolves.toBe('personal');
      await expect(
        service.sendCommand({ action: 'bookmarks.export' }, work.browserId)
      ).resolves.toBe('work');
    });

    test('routes to the only online browser without an explicit target', async () => {
      const work = await pairProfile(EXTENSION_ORIGIN, 'Chrome');
      autoRespond(work.socket, [{ id: 1 }]);
      await expect(service.sendCommand({ action: 'tabs.list' })).resolves.toEqual([{ id: 1 }]);
    });

    test('rejects commands for a browserId that is not connected', async () => {
      await pairProfile(EXTENSION_ORIGIN, 'Chrome');
      await expect(service.sendCommand({ action: 'tabs.list' }, randomUUID())).rejects.toThrow(
        /is not connected/
      );
    });

    test('a reconnecting profile replaces only its own previous socket', async () => {
      const work = await pairProfile(EXTENSION_ORIGIN, 'Chrome');
      const personal = await pairProfile(SECOND_EXTENSION_ORIGIN, 'Edge');
      const replaced = nextClose(work.socket);

      // Same profile reconnects (e.g. service worker woke up): new socket wins.
      const workAgain = await connect(service.getSnapshot().endpoint, EXTENSION_ORIGIN);
      const approved = nextMessage(workAgain);
      workAgain.send(JSON.stringify(pairingRequest(work.browserId, 'Chrome')));
      await approved;

      expect(await replaced).toBe(4000);
      const snapshot = service.getSnapshot();
      expect(snapshot.pairedBrowsers).toHaveLength(2);
      expect(snapshot.pairedBrowsers.every(browser => browser.online)).toBe(true);
      personal.socket.close();
    });

    test('disconnecting one browser only rejects its own pending commands', async () => {
      const work = await pairProfile(EXTENSION_ORIGIN, 'Chrome');
      const personal = await pairProfile(SECOND_EXTENSION_ORIGIN, 'Edge');
      // personal never responds: its command stays pending until disconnect.

      const personalCommand = service.sendCommand({ action: 'tabs.list' }, personal.browserId);
      personal.socket.close();
      await expect(personalCommand).rejects.toThrow('EV Browser disconnected');

      // The other browser keeps serving commands.
      work.socket.once('message', raw => {
        const message = JSON.parse(raw.toString()) as { id: string };
        work.socket.send(
          JSON.stringify({ type: 'browser.response', id: message.id, success: true, data: 'ok' })
        );
      });
      await expect(service.sendCommand({ action: 'tabs.list' }, work.browserId)).resolves.toBe(
        'ok'
      );

      expect(service.getSnapshot()).toMatchObject({
        status: 'connected',
        pairedBrowsers: expect.arrayContaining([
          expect.objectContaining({ browserId: work.browserId, online: true }),
          expect.objectContaining({ browserId: personal.browserId, online: false }),
        ]),
      });
    });

    test('revoking one pairing keeps the others', async () => {
      const work = await pairProfile(EXTENSION_ORIGIN, 'Chrome');
      const personal = await pairProfile(SECOND_EXTENSION_ORIGIN, 'Edge');
      const revoked = nextClose(personal.socket);

      const snapshot = service.revokePairing(personal.browserId);

      expect(await revoked).toBe(4001);
      expect(snapshot.pairedBrowsers).toEqual([
        expect.objectContaining({ browserId: work.browserId, online: true }),
      ]);
      expect(handle.state().identities.map(identity => identity.browserId)).toEqual([
        work.browserId,
      ]);
    });

    test('approval mode keeps several pending requests at once', async () => {
      await service.stop();
      service = new BrowserBridgeService({ port: 0, store: handle.store });
      await service.start();

      const firstId = randomUUID();
      const secondId = randomUUID();
      const first = await connect(service.getSnapshot().endpoint);
      const firstPending = nextMessage(first);
      first.send(JSON.stringify(pairingRequest(firstId)));
      await firstPending;
      const second = await connect(service.getSnapshot().endpoint);
      const secondPending = nextMessage(second);
      second.send(JSON.stringify(pairingRequest(secondId)));
      await secondPending;

      expect(
        service
          .getSnapshot()
          .pendingPairings.map(pending => pending.browserId)
          .sort()
      ).toEqual([firstId, secondId].sort());

      service.approvePendingPairing(firstId);
      const snapshot = service.getSnapshot();
      expect(snapshot.pendingPairings.map(pending => pending.browserId)).toEqual([secondId]);
      expect(snapshot.pairedBrowsers).toEqual([
        expect.objectContaining({ browserId: firstId, online: true }),
      ]);
    });
  });
});
