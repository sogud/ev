import type { BrowserBridgePersistedState, BrowserBridgeStore } from '@ev/browser-host';
import Store from './store';

/** Headless bridge persistence: the pairing token lives in
 * ~/.ev/browser-bridge.json (mode 600). The old desktop app encrypted it with
 * Electron safeStorage; headless we rely on file permissions (P3 hardening). */
export function createBrowserBridgeStore(): BrowserBridgeStore {
  const store = new Store<BrowserBridgePersistedState>({
    name: 'browser-bridge',
    defaults: { pairingToken: null, allowedOrigin: null, browserId: null },
  });
  return {
    get: () => ({
      pairingToken: store.get('pairingToken'),
      allowedOrigin: store.get('allowedOrigin'),
      browserId: store.get('browserId'),
    }),
    set: state => {
      store.set('pairingToken', state.pairingToken);
      store.set('allowedOrigin', state.allowedOrigin);
      store.set('browserId', state.browserId);
    },
  };
}
