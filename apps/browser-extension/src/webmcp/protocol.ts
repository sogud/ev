/**
 * WebMCP bridge message shapes shared by the page-side API (MAIN world), the
 * content-script registry (ISOLATED world), and the background controller.
 *
 * The page keeps `execute` callbacks locally; only JSON-safe tool metadata
 * crosses the world boundary. Every message is validated defensively on the
 * receiving side because page content is untrusted.
 */

export const EV_WEBMCP_PAGE_SOURCE = 'ev-webmcp-page';
export const EV_WEBMCP_HOST_SOURCE = 'ev-webmcp-host';

export const WEBMCP_MAX_TOOLS = 128;
export const WEBMCP_MAX_TOOL_NAME_LENGTH = 128;
export const WEBMCP_MAX_DESCRIPTION_LENGTH = 4_096;
export const WEBMCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const WEBMCP_DEFAULT_TIMEOUT_MS = 30_000;
export const WEBMCP_MAX_TIMEOUT_MS = 60_000;

/** Tool metadata as registered by the page; the execute callback never leaves the page. */
export interface WebMcpToolMetadata {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** MAIN world -> content script: register or replace a tool. */
export interface WebMcpRegisterMessage {
  source: typeof EV_WEBMCP_PAGE_SOURCE;
  kind: 'register';
  tool: WebMcpToolMetadata;
}

/** MAIN world -> content script: remove a tool by name. */
export interface WebMcpUnregisterMessage {
  source: typeof EV_WEBMCP_PAGE_SOURCE;
  kind: 'unregister';
  name: string;
}

/** Content script -> MAIN world: invoke a registered tool. */
export interface WebMcpCallRequestMessage {
  source: typeof EV_WEBMCP_HOST_SOURCE;
  kind: 'call';
  requestId: string;
  name: string;
  args: Record<string, unknown>;
}

/** MAIN world -> content script: serialized tool outcome for a call request. */
export interface WebMcpCallResponseMessage {
  source: typeof EV_WEBMCP_PAGE_SOURCE;
  kind: 'call-response';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  errorCode?: WebMcpPageErrorCode;
}

export type WebMcpPageErrorCode = 'not-found' | 'execution' | 'serialization';

export type WebMcpPageMessage =
  WebMcpRegisterMessage | WebMcpUnregisterMessage | WebMcpCallResponseMessage;

/** chrome.runtime messages sent from the background to the content script. */
export interface WebMcpListToolsRequest {
  type: 'ev-webmcp.listTools';
}

export interface WebMcpCallToolRequest {
  type: 'ev-webmcp.callTool';
  name: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}

export interface ActionHighlightRequest {
  type: 'ev-action.highlight';
  selector: string;
  label: string;
}

export type PageBridgeRequest =
  WebMcpListToolsRequest | WebMcpCallToolRequest | ActionHighlightRequest;

export interface WebMcpListToolsResponse {
  tools: WebMcpToolMetadata[];
}

/** JSON envelope returned for every tool call, success or failure. */
export interface WebMcpCallOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  errorCode?: WebMcpErrorCode;
}

export type WebMcpErrorCode =
  WebMcpPageErrorCode | 'timeout' | 'bridge-unavailable' | 'invalid-response';

/**
 * Normalize arbitrary tool output into a JSON-safe value. Functions, symbols
 * and cyclic structures are rejected instead of silently leaking.
 */
export function toJsonSafeValue(
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(value)) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Value is not JSON-serializable',
    };
  }
}
