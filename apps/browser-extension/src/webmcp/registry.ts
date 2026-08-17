import {
  EV_WEBMCP_HOST_SOURCE,
  EV_WEBMCP_PAGE_SOURCE,
  WEBMCP_MAX_DESCRIPTION_LENGTH,
  WEBMCP_MAX_TOOL_NAME_LENGTH,
  WEBMCP_MAX_TOOLS,
  WEBMCP_TOOL_NAME_PATTERN,
  type WebMcpCallOutcome,
  type WebMcpCallRequestMessage,
  type WebMcpErrorCode,
  type WebMcpToolMetadata,
} from './protocol';

interface PendingCall {
  resolve: (outcome: WebMcpCallOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Per-tab WebMCP tool table maintained by the content script (ISOLATED world).
 * The page posts register/unregister metadata; the background invokes tools
 * through the content script, which round-trips the call into the page and
 * enforces the timeout.
 */
export class WebMcpRegistry {
  private readonly tools = new Map<string, WebMcpToolMetadata>();
  private readonly pendingCalls = new Map<string, PendingCall>();

  list(): WebMcpToolMetadata[] {
    return [...this.tools.values()];
  }

  /** Validate and apply a window message coming from the page MAIN world. */
  handlePageMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const message = data as Record<string, unknown>;
    if (message.source !== EV_WEBMCP_PAGE_SOURCE) return;

    if (message.kind === 'register') {
      const tool = sanitizeToolMetadata(message.tool);
      if (!tool) return;
      if (!this.tools.has(tool.name) && this.tools.size >= WEBMCP_MAX_TOOLS) return;
      this.tools.set(tool.name, tool);
      return;
    }

    if (message.kind === 'unregister') {
      if (typeof message.name === 'string') this.tools.delete(message.name);
      return;
    }

    if (message.kind === 'call-response') {
      const response = message as unknown as {
        requestId?: unknown;
        ok?: unknown;
        result?: unknown;
        error?: unknown;
        errorCode?: unknown;
      };
      if (typeof response.requestId !== 'string') return;
      const pending = this.pendingCalls.get(response.requestId);
      if (!pending) return;
      this.pendingCalls.delete(response.requestId);
      clearTimeout(pending.timer);
      if (response.ok === true) {
        pending.resolve({
          ok: true,
          result: response.result === undefined ? null : response.result,
        });
        return;
      }
      pending.resolve({
        ok: false,
        error: typeof response.error === 'string' ? response.error : 'WebMCP tool call failed',
        errorCode: normalizeErrorCode(response.errorCode) ?? 'execution',
      });
    }
  }

  /**
   * Invoke a registered tool. Posts the call into the page, waits for the
   * serialized outcome, and resolves with a timeout/error envelope instead of
   * throwing.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    requestId: string,
    postToPage: (message: WebMcpCallRequestMessage) => void
  ): Promise<WebMcpCallOutcome> {
    if (!this.tools.has(name)) {
      return { ok: false, error: `WebMCP tool not found: ${name}`, errorCode: 'not-found' };
    }

    return new Promise<WebMcpCallOutcome>(resolve => {
      const timer = setTimeout(() => {
        if (this.pendingCalls.delete(requestId)) {
          resolve({
            ok: false,
            error: `WebMCP tool call timed out after ${timeoutMs}ms`,
            errorCode: 'timeout',
          });
        }
      }, timeoutMs);
      this.pendingCalls.set(requestId, { resolve, timer });
      postToPage({
        source: EV_WEBMCP_HOST_SOURCE,
        kind: 'call',
        requestId,
        name,
        args,
      });
    });
  }

  /** Drop pending calls, e.g. when the page navigates. */
  clearPendingCalls(reason: string): void {
    for (const [requestId, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: reason, errorCode: 'bridge-unavailable' });
      this.pendingCalls.delete(requestId);
    }
  }
}

function sanitizeToolMetadata(tool: unknown): WebMcpToolMetadata | undefined {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return undefined;
  const candidate = tool as Record<string, unknown>;
  if (typeof candidate.name !== 'string') return undefined;
  const name = candidate.name.trim();
  if (
    name.length === 0 ||
    name.length > WEBMCP_MAX_TOOL_NAME_LENGTH ||
    !WEBMCP_TOOL_NAME_PATTERN.test(name)
  ) {
    return undefined;
  }
  const metadata: WebMcpToolMetadata = { name };
  if (typeof candidate.description === 'string') {
    metadata.description = candidate.description.slice(0, WEBMCP_MAX_DESCRIPTION_LENGTH);
  }
  if (
    candidate.inputSchema &&
    typeof candidate.inputSchema === 'object' &&
    !Array.isArray(candidate.inputSchema)
  ) {
    metadata.inputSchema = candidate.inputSchema as Record<string, unknown>;
  }
  return metadata;
}

function normalizeErrorCode(code: unknown): WebMcpErrorCode | undefined {
  if (code === 'not-found' || code === 'execution' || code === 'serialization') return code;
  return undefined;
}
