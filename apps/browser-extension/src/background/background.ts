import { DesktopBridge } from './desktop-bridge';

const desktopBridge = new DesktopBridge();
void desktopBridge.start();

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
