import {
  BridgeConfigSchema,
  DesktopToExtensionMessageSchema,
  EV_PROTOCOL_VERSION,
  type BridgeConfig,
  type ExtensionToDesktopMessage,
} from '@ev/contracts';

import { executeBrowserCommand } from './browser-controller';
import {
  DEFAULT_DESKTOP_BRIDGE_ENDPOINT,
  DESKTOP_BRIDGE_CONFIG_KEY,
} from '../shared/desktop-bridge-config';

const BROWSER_ID_KEY = 'ev_browser_id';
const PAIRING_TOKEN_KEY = 'ev_desktop_bridge_token';
const HEARTBEAT_INTERVAL_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_INBOUND_MESSAGE_BYTES = 1_000_000;

function browserName(): string {
  if (/Edg\//.test(navigator.userAgent)) return 'Edge';
  if (/OPR\//.test(navigator.userAgent)) return 'Opera';
  return 'Chrome';
}

export type DesktopBridgeStatus =
  'disabled' | 'connecting' | 'pairing' | 'connected' | 'disconnected';

export class DesktopBridge {
  private socket: WebSocket | null = null;
  private config: BridgeConfig | null = null;
  private authenticated = false;
  private pairingPending = false;
  private stopped = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  getStatus(): DesktopBridgeStatus {
    if (!this.config) return 'disabled';
    if (this.authenticated) return 'connected';
    if (this.pairingPending) return 'pairing';
    if (this.socket) return 'connecting';
    return 'disconnected';
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    chrome.storage.onChanged.addListener(this.handleStorageChange);
    await this.reloadConfig();
  }

  stop(): void {
    this.stopped = true;
    chrome.storage.onChanged.removeListener(this.handleStorageChange);
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.authenticated = false;
    this.pairingPending = false;
  }

  reconnect(): void {
    if (this.stopped || !this.config) return;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.pairingPending = false;
    this.reconnectAttempts = 0;
    socket?.close();
    this.connect();
  }

  private readonly handleStorageChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ): void => {
    if (areaName === 'local' && changes[DESKTOP_BRIDGE_CONFIG_KEY]) {
      void this.reloadConfig();
    }
  };

  private async reloadConfig(): Promise<void> {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.authenticated = false;
    this.pairingPending = false;
    this.reconnectAttempts = 0;

    const [storedConfig, storedToken] = await Promise.all([
      chrome.storage.local.get(DESKTOP_BRIDGE_CONFIG_KEY),
      chrome.storage.local.get(PAIRING_TOKEN_KEY),
    ]);
    const rawConfig = storedConfig[DESKTOP_BRIDGE_CONFIG_KEY];
    const rawEndpoint =
      rawConfig && typeof rawConfig === 'object' && 'endpoint' in rawConfig
        ? rawConfig.endpoint
        : undefined;
    const parsedEndpoint =
      typeof rawEndpoint === 'string'
        ? BridgeConfigSchema.safeParse({ enabled: true, endpoint: rawEndpoint })
        : null;
    const endpoint = parsedEndpoint?.success ? parsedEndpoint.data.endpoint : undefined;
    const enabledConfig: BridgeConfig = { enabled: true, ...(endpoint ? { endpoint } : {}) };
    this.config = enabledConfig;

    const legacyToken =
      rawConfig && typeof rawConfig === 'object' && 'pairingToken' in rawConfig
        ? rawConfig.pairingToken
        : undefined;
    const migratedToken =
      typeof storedToken[PAIRING_TOKEN_KEY] !== 'string' &&
      typeof legacyToken === 'string' &&
      legacyToken.length >= 16
        ? legacyToken
        : undefined;
    const configNeedsMigration =
      typeof rawConfig !== 'object' ||
      rawConfig === null ||
      !('enabled' in rawConfig) ||
      rawConfig.enabled !== true ||
      Object.keys(rawConfig).some(key => key !== 'enabled' && key !== 'endpoint') ||
      ('endpoint' in (rawConfig ?? {}) && rawConfig?.endpoint !== endpoint);
    if (configNeedsMigration || migratedToken) {
      await chrome.storage.local.set({
        ...(configNeedsMigration ? { [DESKTOP_BRIDGE_CONFIG_KEY]: enabledConfig } : {}),
        ...(migratedToken ? { [PAIRING_TOKEN_KEY]: migratedToken } : {}),
      });
    }
    this.connect();
  }

  private connect(): void {
    if (this.stopped || !this.config || this.socket) return;

    const socket = new WebSocket(this.config.endpoint ?? DEFAULT_DESKTOP_BRIDGE_ENDPOINT);
    this.socket = socket;

    socket.addEventListener('open', () => {
      void this.sendHandshake();
      this.handshakeTimer = setTimeout(() => {
        if (!this.authenticated && !this.pairingPending) socket.close();
      }, HANDSHAKE_TIMEOUT_MS);
    });

    socket.addEventListener('message', event => {
      void this.handleMessage(event.data);
    });

    socket.addEventListener('close', event => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.authenticated = false;
      this.pairingPending = false;
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.stopHeartbeat();
      if (event.code === 1008 && event.reason.includes('Pairing rejected')) {
        void chrome.storage.local.remove(PAIRING_TOKEN_KEY).finally(() => this.scheduleReconnect());
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      socket.close();
    });
  }

  private async sendHandshake(): Promise<void> {
    const [storedBrowser, storedToken] = await Promise.all([
      chrome.storage.local.get(BROWSER_ID_KEY),
      chrome.storage.local.get(PAIRING_TOKEN_KEY),
    ]);
    const browserId =
      typeof storedBrowser[BROWSER_ID_KEY] === 'string'
        ? storedBrowser[BROWSER_ID_KEY]
        : crypto.randomUUID();
    if (storedBrowser[BROWSER_ID_KEY] !== browserId) {
      await chrome.storage.local.set({ [BROWSER_ID_KEY]: browserId });
    }

    const identity = {
      protocolVersion: EV_PROTOCOL_VERSION,
      browserId,
      browserName: browserName(),
      extensionVersion: chrome.runtime.getManifest().version,
    };
    const pairingToken = storedToken[PAIRING_TOKEN_KEY];
    if (typeof pairingToken === 'string' && pairingToken.length >= 16) {
      this.send({ type: 'bridge.hello', ...identity, pairingToken });
      return;
    }
    this.send({ type: 'bridge.pair.request', ...identity });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== 'string' || raw.length > MAX_INBOUND_MESSAGE_BYTES) return;

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return;
    }

    const result = DesktopToExtensionMessageSchema.safeParse(decoded);
    if (!result.success) return;
    const message = result.data;

    if (message.type === 'bridge.pair.pending') {
      this.pairingPending = true;
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      return;
    }
    if (message.type === 'bridge.pair.approved') {
      await chrome.storage.local.set({ [PAIRING_TOKEN_KEY]: message.pairingToken });
      this.markAuthenticated();
      return;
    }
    if (message.type === 'bridge.hello.ack') {
      this.markAuthenticated();
      return;
    }
    if (message.type === 'bridge.pong') return;
    if (!this.authenticated) return;

    try {
      const data = await executeBrowserCommand(message.command);
      this.send({ type: 'browser.response', id: message.id, success: true, data });
    } catch (error) {
      this.send({
        type: 'browser.response',
        id: message.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private markAuthenticated(): void {
    this.authenticated = true;
    this.pairingPending = false;
    this.reconnectAttempts = 0;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'bridge.ping', timestamp: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private send(message: ExtensionToDesktopMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.config || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.stopHeartbeat();
  }
}
