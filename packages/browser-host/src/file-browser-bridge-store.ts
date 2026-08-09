import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserBridgePersistedState, BrowserBridgeStore } from './browser-bridge-service';

const EMPTY_STATE: BrowserBridgePersistedState = {
  pairingToken: null,
  allowedOrigin: null,
  browserId: null,
};

function parseState(value: unknown): BrowserBridgePersistedState {
  if (!value || typeof value !== 'object') return { ...EMPTY_STATE };
  const state = value as Record<string, unknown>;
  return {
    pairingToken:
      typeof state.pairingToken === 'string' &&
      state.pairingToken.length >= 16 &&
      state.pairingToken.length <= 512
        ? state.pairingToken
        : null,
    allowedOrigin: typeof state.allowedOrigin === 'string' ? state.allowedOrigin : null,
    browserId: typeof state.browserId === 'string' ? state.browserId : null,
  };
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
    return { ...this.state };
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
