import {
  EV_WEBMCP_HOST_SOURCE,
  EV_WEBMCP_PAGE_SOURCE,
  WEBMCP_MAX_DESCRIPTION_LENGTH,
  WEBMCP_MAX_TOOL_NAME_LENGTH,
  WEBMCP_MAX_TOOLS,
  WEBMCP_TOOL_NAME_PATTERN,
  toJsonSafeValue,
  type WebMcpCallRequestMessage,
  type WebMcpCallResponseMessage,
  type WebMcpRegisterMessage,
  type WebMcpToolMetadata,
  type WebMcpUnregisterMessage,
} from './protocol';

/** Tool definition accepted by `navigator.modelContext.registerTool`. */
export interface WebMcpPageToolDefinition extends WebMcpToolMetadata {
  execute: (args: Record<string, unknown>) => unknown;
}

export interface WebMcpModelContext {
  registerTool(tool: WebMcpPageToolDefinition): () => void;
  unregisterTool(name: string): boolean;
}

interface ModelContextBridge {
  modelContext: WebMcpModelContext;
  /** Handle a call request posted from the content script. */
  handleHostMessage(data: unknown): void;
  registeredToolNames(): string[];
}

function assertToolDefinition(tool: unknown): asserts tool is WebMcpPageToolDefinition {
  if (!tool || typeof tool !== 'object') {
    throw new TypeError('modelContext.registerTool requires a tool object');
  }
  const candidate = tool as Record<string, unknown>;
  const name = candidate.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('WebMCP tool requires a non-empty name');
  }
  if (name.trim().length > WEBMCP_MAX_TOOL_NAME_LENGTH) {
    throw new TypeError(`WebMCP tool names are limited to ${WEBMCP_MAX_TOOL_NAME_LENGTH} chars`);
  }
  if (!WEBMCP_TOOL_NAME_PATTERN.test(name.trim())) {
    throw new TypeError('WebMCP tool names use letters, digits, dot, dash, underscore');
  }
  if (
    candidate.description !== undefined &&
    (typeof candidate.description !== 'string' ||
      candidate.description.length > WEBMCP_MAX_DESCRIPTION_LENGTH)
  ) {
    throw new TypeError(
      `WebMCP tool description must be a string under ${WEBMCP_MAX_DESCRIPTION_LENGTH} chars`
    );
  }
  if (
    candidate.inputSchema !== undefined &&
    (typeof candidate.inputSchema !== 'object' ||
      candidate.inputSchema === null ||
      Array.isArray(candidate.inputSchema))
  ) {
    throw new TypeError('WebMCP inputSchema must be a JSON object');
  }
  if (typeof candidate.execute !== 'function') {
    throw new TypeError('WebMCP tool requires an execute callback');
  }
}

/**
 * Create the page-side WebMCP state machine. `post` delivers serialized
 * messages to the content script; injected tests can drive it directly.
 */
export function createModelContextBridge(
  post: (
    message: WebMcpRegisterMessage | WebMcpUnregisterMessage | WebMcpCallResponseMessage
  ) => void
): ModelContextBridge {
  const executors = new Map<string, (args: Record<string, unknown>) => unknown>();

  const metadataFor = (tool: WebMcpPageToolDefinition): WebMcpToolMetadata => ({
    name: tool.name.trim(),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
  });

  const registerTool = (tool: WebMcpPageToolDefinition): (() => void) => {
    assertToolDefinition(tool);
    const name = tool.name.trim();
    if (!executors.has(name) && executors.size >= WEBMCP_MAX_TOOLS) {
      throw new Error(`WebMCP pages cannot register more than ${WEBMCP_MAX_TOOLS} tools`);
    }
    executors.set(name, tool.execute);
    post({ source: EV_WEBMCP_PAGE_SOURCE, kind: 'register', tool: metadataFor(tool) });
    return () => unregisterTool(name);
  };

  const unregisterTool = (name: string): boolean => {
    const removed = executors.delete(name);
    if (removed) post({ source: EV_WEBMCP_PAGE_SOURCE, kind: 'unregister', name });
    return removed;
  };

  const handleHostMessage = (data: unknown): void => {
    if (!data || typeof data !== 'object') return;
    const message = data as Record<string, unknown>;
    if (message.source !== EV_WEBMCP_HOST_SOURCE || message.kind !== 'call') return;
    const request = message as unknown as WebMcpCallRequestMessage;
    if (typeof request.requestId !== 'string' || typeof request.name !== 'string') return;
    const respond = (response: Omit<WebMcpCallResponseMessage, 'source' | 'kind' | 'requestId'>) =>
      post({
        source: EV_WEBMCP_PAGE_SOURCE,
        kind: 'call-response',
        requestId: request.requestId,
        ...response,
      });

    const execute = executors.get(request.name);
    if (!execute) {
      respond({
        ok: false,
        error: `WebMCP tool not found: ${request.name}`,
        errorCode: 'not-found',
      });
      return;
    }
    const args = request.args && typeof request.args === 'object' ? request.args : {};
    void Promise.resolve()
      .then(() => execute(args))
      .then(result => {
        const safe = toJsonSafeValue(result);
        if (!safe.ok) {
          respond({
            ok: false,
            error: `WebMCP tool result is not JSON-serializable: ${safe.reason}`,
            errorCode: 'serialization',
          });
          return;
        }
        respond({ ok: true, result: safe.value });
      })
      .catch((error: unknown) => {
        respond({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          errorCode: 'execution',
        });
      });
  };

  return {
    modelContext: { registerTool, unregisterTool },
    handleHostMessage,
    registeredToolNames: () => [...executors.keys()],
  };
}

/**
 * Install `navigator.modelContext` in the page MAIN world and wire it to the
 * content script through window messaging. Installs once per page; a
 * pre-existing standard implementation is left untouched.
 */
export function installModelContextApi(): void {
  const target = navigator as Navigator & { modelContext?: unknown };
  if (target.modelContext) return;

  const bridge = createModelContextBridge(message => window.postMessage(message, '*'));
  Object.defineProperty(navigator, 'modelContext', {
    value: bridge.modelContext,
    configurable: true,
  });
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    bridge.handleHostMessage(event.data);
  });
}
