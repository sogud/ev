import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BrowserAtomicCommandSchema,
  DesktopToExtensionMessageSchema,
  EV_PROTOCOL_VERSION,
  ExtensionToDesktopMessageSchema,
  type BrowserAtomicCommand,
  type ExtensionToDesktopMessage,
} from '@ev/contracts';
import { WebSocket, WebSocketServer } from 'ws';
import type { BrowserBridgeSnapshot } from './types';

const DEFAULT_PORT = 43_121;
const BRIDGE_PATH = '/browser';
const MAX_INBOUND_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_UNAUTHENTICATED_CONNECTIONS = 32;
const MAX_PAIRED_IDENTITIES = 16;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;

/** One paired extension identity (a Chrome profile's EV Browser extension). */
export interface BrowserBridgeIdentity {
  pairingToken: string;
  allowedOrigin: string | null;
  browserId: string | null;
  browserName: string | null;
  pairedAt: number;
}

export interface BrowserBridgePersistedState {
  identities: BrowserBridgeIdentity[];
}

export interface BrowserBridgeStore {
  get(): BrowserBridgePersistedState;
  set(state: BrowserBridgePersistedState): void;
}

interface BrowserBridgeOptions {
  port?: number;
  store: BrowserBridgeStore;
  /**
   * `approval`: every new browser needs one explicit accept, then its pairing
   * token is reused. `automatic`: trust-on-first-use, the first extension to
   * ask is paired immediately (used by hosts that have no approval surface).
   */
  pairingMode?: 'approval' | 'automatic';
}

interface PendingCommand {
  browserId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingPairing {
  socket: WebSocket;
  browserId: string;
  browserName: string;
  extensionVersion: string;
  origin: string;
  requestedAt: number;
  approve(pairingToken: string): void;
}

interface BridgeConnection {
  socket: WebSocket;
  browserId: string;
  browserName: string;
  origin: string;
  connectedAt: number;
  lastSeenAt: number;
}

function isExtensionOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:') &&
      url.hostname.length > 0 &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === '' || url.pathname === '/')
    );
  } catch {
    return false;
  }
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export class BrowserBridgeService {
  private readonly port: number;
  private readonly store: BrowserBridgeStore;
  private readonly pairingMode: 'approval' | 'automatic';
  private readonly listeners = new Set<(snapshot: BrowserBridgeSnapshot) => void>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  /** Live extension connections, one per paired browser profile. */
  private readonly connections = new Map<string, BridgeConnection>();
  /** Awaiting approval (approval mode only), keyed by browserId. */
  private readonly pendingPairings = new Map<string, PendingPairing>();
  private httpServer: HttpServer | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private status: BrowserBridgeSnapshot['status'] = 'stopped';
  private lastError: string | null = null;
  private endpoint: string;

  constructor(options: BrowserBridgeOptions) {
    this.port = options.port ?? DEFAULT_PORT;
    this.store = options.store;
    this.pairingMode = options.pairingMode ?? 'approval';
    this.endpoint = `ws://127.0.0.1:${this.port}${BRIDGE_PATH}`;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;

    const httpServer = createServer((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    });
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_INBOUND_MESSAGE_BYTES,
      perMessageDeflate: false,
    });

    httpServer.on('upgrade', (request, socket, head) => {
      const origin = request.headers.origin ?? '';
      if (request.url !== BRIDGE_PATH || !isExtensionOrigin(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, webSocket => {
        webSocketServer.emit('connection', webSocket, request);
      });
    });

    webSocketServer.on('connection', (socket, request) => {
      if (webSocketServer.clients.size > MAX_UNAUTHENTICATED_CONNECTIONS) {
        socket.close(1013, 'Bridge is busy');
        return;
      }
      const origin = request.headers.origin as string;
      this.handleConnection(socket, origin);
    });

    this.httpServer = httpServer;
    this.webSocketServer = webSocketServer;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer.once('error', onError);
        httpServer.listen(this.port, '127.0.0.1', () => {
          httpServer.off('error', onError);
          resolve();
        });
      });
      const address = httpServer.address() as AddressInfo;
      this.endpoint = `ws://127.0.0.1:${address.port}${BRIDGE_PATH}`;
      this.status = 'listening';
      this.lastError = null;
      this.emit();
    } catch (error) {
      this.httpServer = null;
      this.webSocketServer = null;
      webSocketServer.close();
      this.status = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.rejectPendingCommands(null, new Error('Browser bridge stopped'));
    for (const connection of this.connections.values()) {
      connection.socket.close(1001, 'Desktop bridge stopped');
    }
    for (const pending of this.pendingPairings.values()) {
      pending.socket.close(1001, 'Desktop bridge stopped');
    }
    this.connections.clear();
    this.pendingPairings.clear();

    const webSocketServer = this.webSocketServer;
    const httpServer = this.httpServer;
    this.webSocketServer = null;
    this.httpServer = null;

    for (const client of webSocketServer?.clients ?? []) client.terminate();
    webSocketServer?.close();
    if (httpServer) {
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    }

    this.status = 'stopped';
    this.lastError = null;
    this.emit();
  }

  getSnapshot(): BrowserBridgeSnapshot {
    const identities = this.store.get().identities;
    const pairedBrowsers = identities
      .filter(identity => identity.allowedOrigin !== null && identity.browserId !== null)
      .map(identity => {
        const connection = this.connections.get(identity.browserId as string);
        return {
          browserId: identity.browserId as string,
          browserName: connection?.browserName ?? identity.browserName,
          origin: identity.allowedOrigin as string,
          online: connection !== undefined,
          connectedAt: connection?.connectedAt ?? null,
          lastSeenAt: connection?.lastSeenAt ?? null,
        };
      })
      .sort(
        (a, b) => Number(b.online) - Number(a.online) || b.browserId.localeCompare(a.browserId)
      );

    return {
      status: this.connections.size > 0 ? 'connected' : this.status,
      endpoint: this.endpoint,
      pairedBrowsers,
      pendingPairings: [...this.pendingPairings.values()]
        .map(pending => ({
          browserId: pending.browserId,
          browserName: pending.browserName,
          extensionVersion: pending.extensionVersion,
          origin: pending.origin,
          requestedAt: pending.requestedAt,
        }))
        .sort((a, b) => a.requestedAt - b.requestedAt),
      lastError: this.lastError,
    };
  }

  approvePendingPairing(browserId: string): BrowserBridgeSnapshot {
    const pending = this.pendingPairings.get(browserId);
    if (!pending) throw new Error(`No EV Browser pairing request is pending for ${browserId}`);
    this.pendingPairings.delete(browserId);
    pending.approve(randomBytes(32).toString('base64url'));
    this.emit();
    return this.getSnapshot();
  }

  rejectPendingPairing(browserId: string): BrowserBridgeSnapshot {
    const pending = this.pendingPairings.get(browserId);
    if (!pending) throw new Error(`No EV Browser pairing request is pending for ${browserId}`);
    this.pendingPairings.delete(browserId);
    pending.socket.close(1008, 'Pairing rejected by user');
    this.emit();
    return this.getSnapshot();
  }

  /** Disconnect one connected browser (or all of them) so extensions reconnect. */
  requestReconnect(browserId?: string): BrowserBridgeSnapshot {
    const targets = browserId === undefined ? [...this.connections.values()] : [];
    if (browserId !== undefined) {
      const connection = this.connections.get(browserId);
      if (connection) targets.push(connection);
    }
    for (const connection of targets) {
      this.disconnectConnection(connection, 'Reconnect requested', 4002);
    }
    const pending = browserId === undefined ? [...this.pendingPairings.keys()] : [browserId];
    for (const key of pending) {
      const request = this.pendingPairings.get(key);
      if (!request) continue;
      this.pendingPairings.delete(key);
      request.socket.close(4002, 'Reconnect requested');
    }
    this.emit();
    return this.getSnapshot();
  }

  /**
   * Rotate to a fresh anonymous pairing credential. Existing connections are
   * dropped and all previous identities are forgotten.
   */
  createPairing(): BrowserBridgeSnapshot {
    this.disconnectAll('Pairing credentials rotated');
    this.store.set({
      identities: [
        {
          pairingToken: randomBytes(32).toString('base64url'),
          allowedOrigin: null,
          browserId: null,
          browserName: null,
          pairedAt: Date.now(),
        },
      ],
    });
    this.emit();
    return this.getSnapshot();
  }

  /** Revoke one paired identity by browserId, or every identity when omitted. */
  revokePairing(browserId?: string): BrowserBridgeSnapshot {
    const persisted = this.store.get();
    if (browserId === undefined) {
      this.disconnectAll('Pairing revoked');
      for (const pending of this.pendingPairings.values()) {
        pending.socket.close(1008, 'Pairing revoked');
      }
      this.pendingPairings.clear();
      this.store.set({ identities: [] });
      this.emit();
      return this.getSnapshot();
    }

    const connection = this.connections.get(browserId);
    if (connection) this.disconnectConnection(connection, 'Pairing revoked');
    const pending = this.pendingPairings.get(browserId);
    if (pending) {
      this.pendingPairings.delete(browserId);
      pending.socket.close(1008, 'Pairing revoked');
    }
    this.store.set({
      identities: persisted.identities.filter(identity => identity.browserId !== browserId),
    });
    this.emit();
    return this.getSnapshot();
  }

  subscribe(listener: (snapshot: BrowserBridgeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Resolve which connected browser a command should target. Explicit ids must
   * be online; without one, a lone connection wins; several require an explicit
   * choice so profile-global data is never read from the wrong profile.
   */
  resolveBrowserId(explicitBrowserId?: string): string {
    if (explicitBrowserId !== undefined) {
      if (!this.connections.has(explicitBrowserId)) {
        throw new Error(`EV Browser ${explicitBrowserId} is not connected`);
      }
      return explicitBrowserId;
    }
    if (this.connections.size === 0) throw new Error('EV Browser is not connected');
    if (this.connections.size === 1) return this.connections.keys().next().value as string;
    const ids = [...this.connections.keys()].sort();
    throw new Error(
      `Multiple EV Browsers are connected; pass browserId to pick one (${ids.join(', ')})`
    );
  }

  /** Number of extension connections currently online. */
  connectionCount(): number {
    return this.connections.size;
  }

  async sendCommand(command: BrowserAtomicCommand, browserId?: string): Promise<unknown> {
    const payload = BrowserAtomicCommandSchema.parse(command);
    const target = this.resolveBrowserId(browserId);
    const connection = this.connections.get(target);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`EV Browser ${target} is not connected`);
    }

    const requestId = randomUUID();
    const { browserId: _target, ...wireCommand } = payload;
    const message = DesktopToExtensionMessageSchema.parse({
      type: 'browser.command',
      id: requestId,
      command: wireCommand,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error('Browser command timed out'));
      }, COMMAND_TIMEOUT_MS);
      this.pendingCommands.set(requestId, { browserId: target, resolve, reject, timer });
      connection.socket.send(JSON.stringify(message), error => {
        if (!error) return;
        const pending = this.pendingCommands.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingCommands.delete(requestId);
        pending.reject(error);
      });
    });
  }

  private handleConnection(socket: WebSocket, origin: string): void {
    let authenticated = false;
    let browserId: string | null = null;
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) socket.close(1008, 'Pairing timed out');
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on('message', (raw, isBinary) => {
      const rawBytes = Array.isArray(raw) ? Buffer.concat(raw) : raw;
      if (isBinary || rawBytes.byteLength > MAX_INBOUND_MESSAGE_BYTES) {
        socket.close(1003, 'Unsupported message');
        return;
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(rawBytes.toString());
      } catch {
        socket.close(1007, 'Invalid message');
        return;
      }

      const parsed = ExtensionToDesktopMessageSchema.safeParse(decoded);
      if (!parsed.success) {
        socket.close(1008, 'Invalid protocol message');
        return;
      }
      const message = parsed.data;

      if (!authenticated) {
        if (message.type === 'bridge.pair.request') {
          // Web and null origins are already rejected at the HTTP upgrade, so
          // only a real local extension can get this far. Approval mode holds
          // the request until a user accepts it; automatic mode (hosts with no
          // approval surface) accepts the first one. Extension ids are never
          // allowlisted — an unpacked build gets a fresh id per machine and
          // per directory, so pinning them breaks legitimate rebuilds.
          clearTimeout(handshakeTimer);
          browserId = message.browserId;
          // A newer request from the same profile replaces its older one;
          // requests from other profiles coexist.
          this.pendingPairings
            .get(message.browserId)
            ?.socket.close(4000, 'Replaced by a newer pairing request');
          const pendingPairing: PendingPairing = {
            socket,
            browserId: message.browserId,
            browserName: message.browserName,
            extensionVersion: message.extensionVersion,
            origin,
            requestedAt: Date.now(),
            approve: pairingToken => {
              authenticated = true;
              this.upsertIdentity({
                pairingToken,
                allowedOrigin: origin,
                browserId: message.browserId,
                browserName: message.browserName,
                pairedAt: Date.now(),
              });
              this.bindConnection(socket, message.browserId, message.browserName, origin);
              this.send(socket, {
                type: 'bridge.pair.approved',
                protocolVersion: EV_PROTOCOL_VERSION,
                pairingToken,
              });
            },
          };
          this.pendingPairings.set(message.browserId, pendingPairing);
          const knownIdentity = this.store
            .get()
            .identities.some(
              identity =>
                identity.allowedOrigin === origin && identity.browserId === message.browserId
            );
          if (this.pairingMode === 'automatic' || knownIdentity) {
            this.pendingPairings.delete(message.browserId);
            pendingPairing.approve(randomBytes(32).toString('base64url'));
          } else {
            this.send(socket, { type: 'bridge.pair.pending' });
            this.emit();
          }
          return;
        }
        if (message.type !== 'bridge.hello' || !this.authenticate(message, origin)) {
          socket.close(1008, 'Pairing rejected');
          return;
        }

        authenticated = true;
        clearTimeout(handshakeTimer);
        browserId = message.browserId;
        this.bindConnection(socket, message.browserId, message.browserName, origin);
        this.send(socket, {
          type: 'bridge.hello.ack',
          protocolVersion: EV_PROTOCOL_VERSION,
        });
        return;
      }

      if (message.type === 'bridge.ping') {
        const connection = browserId ? this.connections.get(browserId) : undefined;
        if (connection) {
          connection.lastSeenAt = Date.now();
          this.emit();
        }
        this.send(socket, {
          type: 'bridge.pong',
          timestamp: message.timestamp,
        });
        return;
      }

      if (message.type === 'browser.response') {
        const connection = browserId ? this.connections.get(browserId) : undefined;
        if (connection) connection.lastSeenAt = Date.now();
        const pending = this.pendingCommands.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingCommands.delete(message.id);
        if (message.success) pending.resolve(message.data);
        else pending.reject(new Error(message.error));
      }
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      for (const [key, pending] of this.pendingPairings) {
        if (pending.socket === socket) this.pendingPairings.delete(key);
      }
      if (browserId === null) return;
      const connection = this.connections.get(browserId);
      if (!connection || connection.socket !== socket) return;
      this.connections.delete(browserId);
      this.rejectPendingCommands(browserId, new Error('EV Browser disconnected'));
      this.emit();
    });

    socket.on('error', () => {
      socket.close();
    });
  }

  private authenticate(
    message: Extract<ExtensionToDesktopMessage, { type: 'bridge.hello' }>,
    origin: string
  ): boolean {
    const persisted = this.store.get();
    const identity = persisted.identities.find(candidate =>
      tokensMatch(message.pairingToken, candidate.pairingToken)
    );
    if (!identity) return false;
    if (identity.allowedOrigin !== null && identity.allowedOrigin !== origin) return false;
    if (identity.browserId !== null && identity.browserId !== message.browserId) return false;

    if (identity.allowedOrigin === null || identity.browserId === null) {
      this.upsertIdentity({
        ...identity,
        allowedOrigin: origin,
        browserId: message.browserId,
        browserName: message.browserName,
        pairedAt: Date.now(),
      });
    }
    return true;
  }

  private bindConnection(
    socket: WebSocket,
    browserId: string,
    browserName: string,
    origin: string
  ): void {
    const existing = this.connections.get(browserId);
    if (existing && existing.socket !== socket) {
      existing.socket.close(4000, 'Replaced by a newer connection');
    }
    this.connections.set(browserId, {
      socket,
      browserId,
      browserName,
      origin,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    this.lastError = null;
    this.emit();
  }

  private disconnectConnection(
    connection: BridgeConnection,
    reason: string,
    closeCode = 4001
  ): void {
    this.connections.delete(connection.browserId);
    this.rejectPendingCommands(connection.browserId, new Error(reason));
    connection.socket.close(closeCode, reason);
  }

  private disconnectAll(reason: string): void {
    for (const connection of [...this.connections.values()]) {
      this.disconnectConnection(connection, reason);
    }
  }

  private upsertIdentity(identity: BrowserBridgeIdentity): void {
    const persisted = this.store.get();
    // Replace the same identity slot (origin + browserId) or the same
    // credential: pinning an anonymous pairing token must consume it, so it
    // can never authenticate a second, different browser afterwards.
    const kept = persisted.identities.filter(
      candidate =>
        candidate.pairingToken !== identity.pairingToken &&
        !(
          candidate.browserId === identity.browserId &&
          candidate.allowedOrigin === identity.allowedOrigin
        )
    );
    kept.push(identity);
    // Bound the identity list; drop the oldest offline identity first.
    // Bound the identity list; drop the oldest offline identity first. Never
    // evict an online browser's pairing — if every identity is online, allow
    // the list to exceed the cap until one of them disconnects.
    while (kept.length > MAX_PAIRED_IDENTITIES) {
      let oldestIndex = -1;
      for (let index = 0; index < kept.length; index += 1) {
        const candidate = kept[index];
        if (this.connections.has(candidate.browserId ?? '')) continue;
        if (oldestIndex === -1 || candidate.pairedAt < kept[oldestIndex].pairedAt) {
          oldestIndex = index;
        }
      }
      if (oldestIndex === -1) break;
      kept.splice(oldestIndex, 1);
    }
    this.store.set({ identities: kept });
  }

  private send(socket: WebSocket, message: unknown): void {
    const validated = DesktopToExtensionMessageSchema.parse(message);
    socket.send(JSON.stringify(validated));
  }

  private rejectPendingCommands(browserId: string | null, error: Error): void {
    for (const [requestId, pending] of this.pendingCommands) {
      if (browserId !== null && pending.browserId !== browserId) continue;
      clearTimeout(pending.timer);
      this.pendingCommands.delete(requestId);
      pending.reject(error);
    }
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
