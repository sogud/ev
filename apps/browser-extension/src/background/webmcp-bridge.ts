import type {
  PageBridgeRequest,
  WebMcpCallOutcome,
  WebMcpCallToolRequest,
  WebMcpListToolsResponse,
  WebMcpToolMetadata,
} from '../webmcp/protocol';

const RECEIVE_END_PATTERN = /receiving end does not exist|message port closed|no tab with id/i;

/** Chrome runtime messaging is unavailable when the content script is absent. */
export class PageBridgeUnavailableError extends Error {
  constructor(tabId: number) {
    super(`EV page bridge is unavailable on tab ${tabId}; reload the page and retry`);
    this.name = 'PageBridgeUnavailableError';
  }
}

async function sendPageBridgeRequest<T>(tabId: number, request: PageBridgeRequest): Promise<T> {
  const tabsApi = chrome.tabs;
  if (!tabsApi?.sendMessage) throw new PageBridgeUnavailableError(tabId);
  let response: unknown;
  try {
    response = await tabsApi.sendMessage(tabId, request);
  } catch (error) {
    if (error instanceof Error && RECEIVE_END_PATTERN.test(error.message)) {
      throw new PageBridgeUnavailableError(tabId);
    }
    throw error;
  }
  if (response === undefined) throw new PageBridgeUnavailableError(tabId);
  return response as T;
}

/** List the WebMCP tools registered by the page in this tab. */
export async function listPageWebMcpTools(tabId: number): Promise<WebMcpToolMetadata[]> {
  const response = await sendPageBridgeRequest<WebMcpListToolsResponse>(tabId, {
    type: 'ev-webmcp.listTools',
  });
  const tools = Array.isArray(response?.tools) ? response.tools : [];
  return tools.filter(
    (tool): tool is WebMcpToolMetadata =>
      Boolean(tool) && typeof tool === 'object' && typeof tool.name === 'string'
  );
}

/** Invoke a page-registered WebMCP tool; resolves with a JSON error envelope. */
export async function callPageWebMcpTool(
  tabId: number,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<WebMcpCallOutcome> {
  const request: WebMcpCallToolRequest = { type: 'ev-webmcp.callTool', name, args, timeoutMs };
  try {
    const outcome = await sendPageBridgeRequest<WebMcpCallOutcome>(tabId, request);
    if (!outcome || typeof outcome.ok !== 'boolean') {
      return {
        ok: false,
        error: 'WebMCP bridge returned an invalid response',
        errorCode: 'invalid-response',
      };
    }
    return outcome;
  } catch (error) {
    if (error instanceof PageBridgeUnavailableError) {
      return { ok: false, error: error.message, errorCode: 'bridge-unavailable' };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'bridge-unavailable',
    };
  }
}

/**
 * Ask the content script to highlight a target element. Best effort: a
 * missing bridge or selector must never fail the surrounding page action.
 */
export async function requestActionHighlight(
  tabId: number,
  selector: string,
  label: string
): Promise<void> {
  try {
    await sendPageBridgeRequest<{ highlighted: boolean }>(tabId, {
      type: 'ev-action.highlight',
      selector,
      label,
    });
  } catch {
    // Highlights are cosmetic; never surface rendering failures to callers.
  }
}
