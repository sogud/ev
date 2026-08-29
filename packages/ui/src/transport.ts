import { createEvClient, type EvClient } from '@ev/contracts/client';

// Window global consumed by the store/components; set by installTransport().
// Declared here (not in a standalone d.ts) so the augmentation rides along with
// every consumer that imports this package.
declare global {
  interface Window {
    agentDesktop: EvClient;
  }
}

/**
 * Transport = the wire between the shared UI and the EV server.
 *
 * server-client-split-v1: the Electron IPC layer is gone; the desktop renderer and
 * the web form are isomorphic HTTP+WS clients built on `createEvClient`. Both
 * transports therefore produce the same `EvClient` — they only differ in where the
 * connection params come from:
 * - electron: desktop main injects `#port=..&token=..` into the loaded URL;
 * - web: the operator opens the page with `?port=..&token=..` (or hash) so a plain
 *   browser can reach a local `ev server`.
 */
export interface Transport {
  readonly kind: 'electron' | 'web';
  readonly client: EvClient;
  dispose(): void;
}

function readParams(preferHash: boolean): { port: string; token: string } {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(preferHash && hash ? hash : hash || window.location.search);
  return {
    port: params.get('port') ?? window.location.port ?? '7877',
    token: params.get('token') ?? '',
  };
}

function build(kind: Transport['kind'], preferHash: boolean): Transport {
  const { port, token } = readParams(preferHash);
  // Same-origin when the page itself is served by the EV server (any host:port);
  // hardcoded loopback only applies to the vite dev origin.
  const baseUrl =
    window.location.port === port ? window.location.origin : `http://127.0.0.1:${port}`;
  const client = createEvClient({
    baseUrl,
    token,
    device: deviceIdentity(kind),
  });
  return { kind, client, dispose: () => client.close() };
}

/**
 * Stable per-browser-profile device id (localStorage) so refreshes keep the
 * same identity; the server's presence list shows one row per device.
 */
function deviceIdentity(kind: Transport['kind']): { id: string; name: string; kind: string } {
  let id: string;
  try {
    const key = 'ev-device-id';
    id = window.localStorage.getItem(key) ?? '';
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem(key, id);
    }
  } catch {
    id = `session-${Math.random().toString(36).slice(2, 10)}`;
  }
  const label = kind === 'electron' ? 'Desktop' : 'Web';
  return { id, kind, name: `${label} · ${id.slice(0, 4)}` };
}

/** Desktop transport: params come from the URL hash injected by Electron main. */
export function createElectronTransport(): Transport {
  return build('electron', true);
}

/** Web transport: params come from the URL (hash or query) of a plain browser page. */
export function createWebTransport(): Transport {
  return build('web', false);
}

/** Publish the transport on the window global consumed by the store/components. */
export function installTransport(transport: Transport): EvClient {
  window.agentDesktop = transport.client;
  return transport.client;
}
