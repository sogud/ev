import { beforeEach, describe, expect, test, vi } from 'vitest';

import { DesktopBridge } from './desktop-bridge';
import { DEFAULT_DESKTOP_BRIDGE_ENDPOINT } from '../shared/desktop-bridge-config';

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly sent: unknown[] = [];
  readyState = 0;

  constructor(readonly url: string) {
    super();
    sockets.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  send(value: string): void {
    try {
      this.sent.push(JSON.parse(value));
    } catch (error) {
      throw new Error('DesktopBridge sent invalid JSON', { cause: error });
    }
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    const event = new Event('close');
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
  }
}

const sockets: FakeWebSocket[] = [];
const localStorage: Record<string, unknown> = {};

beforeEach(() => {
  sockets.length = 0;
  for (const key of Object.keys(localStorage)) delete localStorage[key];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.chrome = {
    runtime: {
      getManifest: vi.fn(() => ({ version: '1.0.0' })),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: localStorage[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => Object.assign(localStorage, value)),
        remove: vi.fn(async (key: string) => {
          delete localStorage[key];
        }),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  } as unknown as typeof chrome;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Chrome/142.0' },
  });
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { randomUUID: () => '3f88e635-1ba1-4e8c-91fd-83d682959f8a' },
  });
});

describe('DesktopBridge automatic pairing', () => {
  test('connects to the default endpoint, stores approval, and reconnects on request', async () => {
    const bridge = new DesktopBridge();

    await bridge.start();
    expect(sockets[0]?.url).toBe(DEFAULT_DESKTOP_BRIDGE_ENDPOINT);
    sockets[0].open();
    await vi.waitFor(() =>
      expect(sockets[0].sent).toContainEqual({
        type: 'bridge.pair.request',
        protocolVersion: 1,
        browserId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
        browserName: 'Chrome',
        extensionVersion: '1.0.0',
      })
    );

    sockets[0].message({ type: 'bridge.pair.pending' });
    await Promise.resolve();
    expect(bridge.getStatus()).toBe('pairing');
    sockets[0].message({
      type: 'bridge.pair.approved',
      protocolVersion: 1,
      pairingToken: 'a'.repeat(43),
    });
    await vi.waitFor(() => expect(bridge.getStatus()).toBe('connected'));
    expect(localStorage.ev_desktop_bridge_token).toBe('a'.repeat(43));

    bridge.reconnect();
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toBe(DEFAULT_DESKTOP_BRIDGE_ENDPOINT);
    bridge.stop();
  });

  test('re-enables a previously disabled bridge because browser capabilities are always on', async () => {
    localStorage.ev_desktop_bridge = { enabled: false };
    const bridge = new DesktopBridge();

    await bridge.start();
    expect(localStorage.ev_desktop_bridge).toEqual({ enabled: true });
    expect(sockets[0]?.url).toBe(DEFAULT_DESKTOP_BRIDGE_ENDPOINT);
    bridge.stop();
  });

  test('migrates a legacy inline token and keeps a valid endpoint field', async () => {
    localStorage.ev_desktop_bridge = {
      enabled: true,
      endpoint: 'ws://127.0.0.1:43122/browser',
      pairingToken: 'legacy-pairing-token',
    };
    const bridge = new DesktopBridge();

    await bridge.start();
    expect(localStorage.ev_desktop_bridge).toEqual({
      enabled: true,
      endpoint: 'ws://127.0.0.1:43122/browser',
    });
    expect(localStorage.ev_desktop_bridge_token).toBe('legacy-pairing-token');
    expect(sockets[0]?.url).toBe('ws://127.0.0.1:43122/browser');
    sockets[0].open();
    await vi.waitFor(() =>
      expect(sockets[0].sent).toContainEqual(
        expect.objectContaining({ type: 'bridge.hello', pairingToken: 'legacy-pairing-token' })
      )
    );
    bridge.stop();
  });

  test('drops an invalid endpoint field and falls back to the default', async () => {
    localStorage.ev_desktop_bridge = {
      enabled: true,
      endpoint: 'wss://remote.example/browser',
    };
    const bridge = new DesktopBridge();

    await bridge.start();
    expect(localStorage.ev_desktop_bridge).toEqual({ enabled: true });
    expect(sockets[0]?.url).toBe(DEFAULT_DESKTOP_BRIDGE_ENDPOINT);
    bridge.stop();
  });

  test('clears a rejected token before retrying automatic pairing', async () => {
    localStorage.ev_desktop_bridge_token = 'rejected-pairing-token';
    const bridge = new DesktopBridge();

    await bridge.start();
    sockets[0].open();
    await vi.waitFor(() =>
      expect(sockets[0].sent).toContainEqual(
        expect.objectContaining({ type: 'bridge.hello', pairingToken: 'rejected-pairing-token' })
      )
    );
    sockets[0].close(1008, 'Pairing rejected');
    await vi.waitFor(() => expect(localStorage.ev_desktop_bridge_token).toBeUndefined());
    bridge.stop();
  });
});
