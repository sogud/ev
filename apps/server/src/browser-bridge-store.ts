import type { BrowserBridgePersistedState, BrowserBridgeStore } from '@ev/browser-host';
import Store from './store';

interface LegacyBridgeState {
  pairingToken: string | null;
  allowedOrigin: string | null;
  browserId: string | null;
}

/** Headless bridge persistence: pairing identities live in
 * ~/.ev/browser-bridge.json (mode 600). The old desktop app encrypted it with
 * Electron safeStorage; headless we rely on file permissions (P3 hardening). */
export function createBrowserBridgeStore(): BrowserBridgeStore {
  const store = new Store<BrowserBridgePersistedState>({
    name: 'browser-bridge',
    defaults: { identities: [] },
  });
  // One-time migration from the legacy single-identity layout; the legacy
  // token is nulled afterwards so the migration cannot run twice.
  const legacy = new Store<LegacyBridgeState>({
    name: 'browser-bridge',
    defaults: { pairingToken: null, allowedOrigin: null, browserId: null },
  });
  const legacyToken = legacy.get('pairingToken');
  if (typeof legacyToken === 'string' && legacyToken.length >= 16) {
    const identities = [...store.get('identities')];
    if (!identities.some(identity => identity.pairingToken === legacyToken)) {
      identities.push({
        pairingToken: legacyToken,
        allowedOrigin: legacy.get('allowedOrigin'),
        browserId: legacy.get('browserId'),
        browserName: null,
        pairedAt: Date.now(),
      });
      store.set('identities', identities);
    }
    legacy.set('pairingToken', null);
  }

  return {
    get: () => {
      const identities = store.get('identities');
      return { identities: Array.isArray(identities) ? identities : [] };
    },
    set: state => {
      store.set('identities', state.identities);
    },
  };
}
