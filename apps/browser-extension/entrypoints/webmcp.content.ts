import { drawActionHighlight } from '../src/content/action-highlight';
import {
  WEBMCP_DEFAULT_TIMEOUT_MS,
  WEBMCP_MAX_TIMEOUT_MS,
  WEBMCP_MAX_TOOL_NAME_LENGTH,
} from '../src/webmcp/protocol';
import { WebMcpRegistry } from '../src/webmcp/registry';

/**
 * EV page bridge (ISOLATED world): keeps the WebMCP tool table for this tab,
 * relays tool calls between the background and the page MAIN world, and
 * renders action highlights on request.
 */
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_start',
  main() {
    const registry = new WebMcpRegistry();

    window.addEventListener('message', event => {
      if (event.source !== window) return;
      registry.handlePageMessage(event.data);
    });

    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') return false;
      const request = message as Record<string, unknown>;

      if (request.type === 'ev-webmcp.listTools') {
        sendResponse({ tools: registry.list() });
        return false;
      }

      if (request.type === 'ev-webmcp.callTool') {
        const name =
          typeof request.name === 'string'
            ? request.name.slice(0, WEBMCP_MAX_TOOL_NAME_LENGTH + 1)
            : '';
        const rawTimeout = request.timeoutMs;
        const timeoutMs =
          typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
            ? Math.min(Math.max(rawTimeout, 100), WEBMCP_MAX_TIMEOUT_MS)
            : WEBMCP_DEFAULT_TIMEOUT_MS;
        const args =
          request.args && typeof request.args === 'object' && !Array.isArray(request.args)
            ? (request.args as Record<string, unknown>)
            : {};
        const requestId = crypto.randomUUID();
        void registry
          .callTool(name, args, timeoutMs, requestId, call => window.postMessage(call, '*'))
          .then(outcome => sendResponse(outcome));
        return true;
      }

      if (request.type === 'ev-action.highlight') {
        const selector = typeof request.selector === 'string' ? request.selector : '';
        const label = typeof request.label === 'string' ? request.label.slice(0, 32) : 'action';
        let element: Element | null = null;
        if (selector) {
          try {
            element = document.querySelector(selector);
          } catch {
            element = null;
          }
        }
        if (element) drawActionHighlight(element, label);
        sendResponse({ highlighted: element !== null });
        return false;
      }

      return false;
    });
  },
});
