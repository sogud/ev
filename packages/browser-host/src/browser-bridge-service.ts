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
const MAX_UNAUTHENTICATED_CONNECTIONS = 16;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;

export interface BrowserBridgePersistedState {
  pairingToken: string | null;
  allowedOrigin: string | null;
  browserId: string | null;
}

export interface BrowserBridgeStore {
  get(): BrowserBridgePersistedState;
  set(state: BrowserBridgePersistedState): void;
}

interface BrowserBridgeOptions {
  port?: number;
  store: BrowserBridgeStore;
  pairingMode?: 'approval' | 'automatic';
  automaticPairingOrigins?: readonly string[];
}

interface PendingCommand {
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
  private readonly automaticPairingOrigins: ReadonlySet<string>;
  private readonly listeners = new Set<(snapshot: BrowserBridgeSnapshot) => void>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private httpServer: HttpServer | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private activeSocket: WebSocket | null = null;
  private activeBrowserId: string | null = null;
  private pendingPairing: PendingPairing | null = null;
  private connectedAt: number | null = null;
  private lastSeenAt: number | null = null;
  private endpoint: string;
  private status: BrowserBridgeSnapshot['status'] = 'stopped';
  private lastError: string | null = null;

  constructor(options: BrowserBridgeOptions) {
    this.port = options.port ?? DEFAULT_PORT;
    this.store = options.store;
    this.pairingMode = options.pairingMode ?? 'approval';
    this.automaticPairingOrigins = new Set(options.automaticPairingOrigins ?? []);
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
    this.rejectPendingCommands(new Error('Browser bridge stopped'));
    this.activeSocket?.close(1001, 'Desktop bridge stopped');
    this.pendingPairing?.socket.close(1001, 'Desktop bridge stopped');
    this.activeSocket = null;
    this.pendingPairing = null;
    this.activeBrowserId = null;
    this.connectedAt = null;
    this.lastSeenAt = null;

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
    const persisted = this.store.get();
    return {
      status: this.status,
      endpoint: this.endpoint,
      pairingToken: persisted.pairingToken,
      pairedOrigin: persisted.allowedOrigin,
      browserId: this.activeBrowserId ?? persisted.browserId,
      pendingPairing: this.pendingPairing
        ? {
            browserId: this.pendingPairing.browserId,
            browserName: this.pendingPairing.browserName,
            extensionVersion: this.pendingPairing.extensionVersion,
            origin: this.pendingPairing.origin,
            requestedAt: this.pendingPairing.requestedAt,
          }
        : null,
      connectedAt: this.connectedAt,
      lastSeenAt: this.lastSeenAt,
      lastError: this.lastError,
    };
  }

  approvePendingPairing(): BrowserBridgeSnapshot {
    const pending = this.pendingPairing;
    if (!pending) throw new Error('No EV Browser pairing request is pending');
    const pairingToken = randomBytes(32).toString('base64url');
    this.pendingPairing = null;
    pending.approve(pairingToken);
    this.emit();
    return this.getSnapshot();
  }

  rejectPendingPairing(): BrowserBridgeSnapshot {
    this.pendingPairing?.socket.close(1008, 'Pairing rejected by user');
    this.pendingPairing = null;
    this.emit();
    return this.getSnapshot();
  }

  requestReconnect(): BrowserBridgeSnapshot {
    this.pendingPairing?.socket.close(4002, 'Reconnect requested');
    this.pendingPairing = null;
    this.disconnectActiveSocket('Reconnect requested', 4002);
    this.emit();
    return this.getSnapshot();
  }

  createPairing(): BrowserBridgeSnapshot {
    this.disconnectActiveSocket('Pairing credentials rotated');
    this.store.set({
      pairingToken: randomBytes(32).toString('base64url'),
      allowedOrigin: null,
      browserId: null,
    });
    this.emit();
    return this.getSnapshot();
  }

  revokePairing(): BrowserBridgeSnapshot {
    this.disconnectActiveSocket('Pairing revoked');
    this.pendingPairing?.socket.close(1008, 'Pairing revoked');
    this.pendingPairing = null;
    this.store.set({ pairingToken: null, allowedOrigin: null, browserId: null });
    this.emit();
    return this.getSnapshot();
  }

  subscribe(listener: (snapshot: BrowserBridgeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendCommand(command: BrowserAtomicCommand): Promise<unknown> {
    const payload = BrowserAtomicCommandSchema.parse(command);
    const socket = this.activeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('EV Browser is not connected');
    }

    const requestId = randomUUID();
    const message = DesktopToExtensionMessageSchema.parse({
      type: 'browser.command',
      id: requestId,
      command: payload,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error('Browser command timed out'));
      }, COMMAND_TIMEOUT_MS);
      this.pendingCommands.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify(message), error => {
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
          if (this.pairingMode === 'automatic') {
            // Trust-on-first-use: with no explicit allowlist, any genuine
            // extension origin may pair (the persisted identity pins later
            // pairings). Web/null origins can never auto-pair, so a page
            // cannot hijack the bridge over loopback.
            const trusted =
              isExtensionOrigin(origin) &&
              (this.automaticPairingOrigins.size === 0 || this.automaticPairingOrigins.has(origin));
            if (!trusted) {
              socket.close(1008, 'Extension origin is not trusted for automatic pairing');
              return;
            }
          }
          if (this.activeSocket) {
            socket.close(1008, 'EV Browser is already paired and connected');
            return;
          }
          clearTimeout(handshakeTimer);
          this.pendingPairing?.socket.close(4000, 'Replaced by a newer pairing request');
          browserId = message.browserId;
          this.pendingPairing = {
            socket,
            browserId: message.browserId,
            browserName: message.browserName,
            extensionVersion: message.extensionVersion,
            origin,
            requestedAt: Date.now(),
            approve: pairingToken => {
              authenticated = true;
              this.store.set({
                pairingToken,
                allowedOrigin: origin,
                browserId: message.browserId,
              });
              this.bindActiveSocket(socket, message.browserId, origin);
              this.send(socket, {
                type: 'bridge.pair.approved',
                protocolVersion: EV_PROTOCOL_VERSION,
                pairingToken,
              });
            },
          };
          const persisted = this.store.get();
          const knownIdentity =
            persisted.allowedOrigin === origin && persisted.browserId === message.browserId;
          if (this.pairingMode === 'automatic' || knownIdentity) {
            const pairingToken = randomBytes(32).toString('base64url');
            const pending = this.pendingPairing;
            this.pendingPairing = null;
            pending.approve(pairingToken);
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
        this.bindActiveSocket(socket, browserId, origin);
        this.send(socket, {
          type: 'bridge.hello.ack',
          protocolVersion: EV_PROTOCOL_VERSION,
        });
        return;
      }

      if (message.type === 'bridge.ping') {
        this.lastSeenAt = Date.now();
        this.send(socket, {
          type: 'bridge.pong',
          timestamp: message.timestamp,
        });
        this.emit();
        return;
      }

      if (message.type === 'browser.response') {
        this.lastSeenAt = Date.now();
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
      if (this.pendingPairing?.socket === socket) {
        this.pendingPairing = null;
        this.emit();
      }
      if (this.activeSocket !== socket) return;
      this.activeSocket = null;
      this.activeBrowserId = null;
      this.connectedAt = null;
      this.lastSeenAt = null;
      this.status = this.httpServer ? 'listening' : 'stopped';
      this.rejectPendingCommands(new Error('EV Browser disconnected'));
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
    if (!persisted.pairingToken || !tokensMatch(message.pairingToken, persisted.pairingToken)) {
      return false;
    }
    if (persisted.allowedOrigin && persisted.allowedOrigin !== origin) return false;
    if (persisted.browserId && persisted.browserId !== message.browserId) return false;

    if (!persisted.allowedOrigin || !persisted.browserId) {
      this.store.set({
        pairingToken: persisted.pairingToken,
        allowedOrigin: origin,
        browserId: message.browserId,
      });
    }
    return true;
  }

  private bindActiveSocket(socket: WebSocket, browserId: string, origin: string): void {
    if (this.activeSocket && this.activeSocket !== socket) {
      this.activeSocket.close(4000, 'Replaced by a newer connection');
    }
    this.activeSocket = socket;
    this.activeBrowserId = browserId;
    this.connectedAt = Date.now();
    this.lastSeenAt = this.connectedAt;
    this.status = 'connected';
    this.lastError = null;
    this.store.set({
      pairingToken: this.store.get().pairingToken,
      allowedOrigin: origin,
      browserId,
    });
    this.emit();
  }

  private disconnectActiveSocket(reason: string, closeCode = 4001): void {
    this.rejectPendingCommands(new Error(reason));
    this.activeSocket?.close(closeCode, reason);
    this.activeSocket = null;
    this.activeBrowserId = null;
    this.connectedAt = null;
    this.lastSeenAt = null;
    this.status = this.httpServer ? 'listening' : 'stopped';
  }

  private send(socket: WebSocket, message: unknown): void {
    const validated = DesktopToExtensionMessageSchema.parse(message);
    socket.send(JSON.stringify(validated));
  }

  private rejectPendingCommands(error: Error): void {
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCommands.clear();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
