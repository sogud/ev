import { DesktopBridge } from './desktop-bridge';

const BRIDGE_KEEPALIVE_ALARM = 'ev-bridge-keepalive';

const desktopBridge = new DesktopBridge();
void desktopBridge.start();

// MV3 suspends an idle service worker, which kills the bridge's reconnect
// timers along with it. A periodic alarm wakes the worker so the bridge can
// recover its Host connection without the user clicking the extension.
chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== BRIDGE_KEEPALIVE_ALARM) return;
  desktopBridge.ensureConnected();
});

// Every wake path is a silent reconnect opportunity: SW startup, browser
// startup, and the user focusing a window all recover the Host connection
// without any manual action.
chrome.runtime.onStartup.addListener(() => desktopBridge.ensureConnected());
chrome.windows?.onFocusChanged?.addListener(() => desktopBridge.ensureConnected());
chrome.tabs?.onUpdated?.addListener(() => desktopBridge.ensureConnected());

chrome.runtime.onMessage.addListener((request: unknown, _sender, sendResponse) => {
  if (!request || typeof request !== 'object') return false;
  const action = 'action' in request ? request.action : undefined;

  if (action === 'ping') {
    sendResponse({ success: true, message: 'pong' });
    return false;
  }

  if (action === 'bridge.status') {
    sendResponse({ success: true, status: desktopBridge.getStatus() });
    return false;
  }

  if (action === 'bridge.reconnect') {
    desktopBridge.reconnect();
    sendResponse({ success: true, status: desktopBridge.getStatus() });
    return false;
  }

  return false;
});
