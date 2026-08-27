import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  BrowserBridgeIdentity,
  BrowserBridgePersistedState,
  BrowserBridgeStore,
} from './browser-bridge-service';

const EMPTY_STATE: BrowserBridgePersistedState = { identities: [] };

function parseToken(value: unknown): string | null {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512 ? value : null;
}

function parseIdentity(value: unknown): BrowserBridgeIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const identity = value as Record<string, unknown>;
  const pairingToken = parseToken(identity.pairingToken);
  if (!pairingToken) return null;
  return {
    pairingToken,
    allowedOrigin: typeof identity.allowedOrigin === 'string' ? identity.allowedOrigin : null,
    browserId: typeof identity.browserId === 'string' ? identity.browserId : null,
    browserName: typeof identity.browserName === 'string' ? identity.browserName : null,
    pairedAt:
      typeof identity.pairedAt === 'number' && Number.isFinite(identity.pairedAt)
        ? identity.pairedAt
        : Date.now(),
  };
}

function parseState(value: unknown): BrowserBridgePersistedState {
  if (!value || typeof value !== 'object') return { identities: [] };
  const state = value as Record<string, unknown>;

  // Current shape: a list of paired identities.
  if (Array.isArray(state.identities)) {
    const identities = state.identities
      .map(parseIdentity)
      .filter((identity): identity is BrowserBridgeIdentity => identity !== null);
    return { identities };
  }

  // Legacy single-identity shape: migrate into a one-entry list so an already
  // paired browser keeps working across the upgrade.
  const legacy = parseIdentity(state);
  return legacy ? { identities: [legacy] } : { identities: [] };
}

export class FileBrowserBridgeStore implements BrowserBridgeStore {
  private state: BrowserBridgePersistedState;

  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(filePath), 0o700);
    try {
      this.state = parseState(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch {
      this.state = { ...EMPTY_STATE };
    }
  }

  get(): BrowserBridgePersistedState {
    return { identities: this.state.identities.map(identity => ({ ...identity })) };
  }

  set(state: BrowserBridgePersistedState): void {
    this.state = parseState(state);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.filePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}
