import type { BrowserBridgePersistedState, BrowserBridgeStore } from '@ev/browser-host';
import Store from './store';

/** 无头版 bridge 持久化： pairing token 落 ~/.ev/browser-bridge.json（600）。
 * 旧 desktop 用 Electron safeStorage 加密；无头阶段以文件权限保护，P3 硬化项。 */
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
