import { describe, expect, it, vi } from 'vitest';

import { createModelContextBridge } from './page-api';
import { EV_WEBMCP_HOST_SOURCE } from './protocol';

describe('WebMCP page API', () => {
  it('registers tools by posting metadata without the execute callback', () => {
    const posted: unknown[] = [];
    const bridge = createModelContextBridge(message => posted.push(message));

    const dispose = bridge.modelContext.registerTool({
      name: 'search_products',
      description: 'Search the catalog',
      inputSchema: { type: 'object' },
      execute: () => ({ items: [] }),
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      source: 'ev-webmcp-page',
      kind: 'register',
      tool: {
        name: 'search_products',
        description: 'Search the catalog',
        inputSchema: { type: 'object' },
      },
    });
    expect(bridge.registeredToolNames()).toEqual(['search_products']);

    dispose();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({ kind: 'unregister', name: 'search_products' });
    expect(bridge.registeredToolNames()).toEqual([]);
  });

  it('rejects malformed tool definitions', () => {
    const bridge = createModelContextBridge(() => undefined);
    const register = bridge.modelContext.registerTool;

    expect(() => register(undefined as never)).toThrow(TypeError);
    expect(() => register({ name: '', execute: () => null } as never)).toThrow(/non-empty name/);
    expect(() => register({ name: 'bad name', execute: () => null } as never)).toThrow(
      /letters, digits/
    );
    expect(() => register({ name: 'x'.repeat(129), execute: () => null } as never)).toThrow(
      /limited to 128/
    );
    expect(() => register({ name: 'tool' } as never)).toThrow(/execute callback/);
    expect(() =>
      register({ name: 'tool', inputSchema: ['array'], execute: () => null } as never)
    ).toThrow(/JSON object/);
  });

  it('caps the number of registered tools per page', () => {
    const bridge = createModelContextBridge(() => undefined);
    for (let index = 0; index < 128; index += 1) {
      bridge.modelContext.registerTool({ name: `tool_${index}`, execute: () => index });
    }
    expect(() => bridge.modelContext.registerTool({ name: 'overflow', execute: () => 0 })).toThrow(
      /more than 128/
    );
    // Replacing an existing tool stays allowed.
    bridge.modelContext.registerTool({ name: 'tool_0', execute: () => 'replaced' });
    expect(bridge.registeredToolNames()).toHaveLength(128);
  });

  it('executes tools and serializes JSON-safe results', async () => {
    const posted: unknown[] = [];
    const bridge = createModelContextBridge(message => posted.push(message));
    const execute = vi.fn(async (args: Record<string, unknown>) => ({
      echo: args.query,
      nested: { ok: true },
    }));
    bridge.modelContext.registerTool({ name: 'echo', execute });

    bridge.handleHostMessage({
      source: EV_WEBMCP_HOST_SOURCE,
      kind: 'call',
      requestId: 'request-1',
      name: 'echo',
      args: { query: 'keyboard' },
    });
    await vi.waitFor(() => expect(posted).toHaveLength(2));

    expect(execute).toHaveBeenCalledWith({ query: 'keyboard' });
    expect(posted[1]).toEqual({
      source: 'ev-webmcp-page',
      kind: 'call-response',
      requestId: 'request-1',
      ok: true,
      result: { echo: 'keyboard', nested: { ok: true } },
    });
  });

  it('maps undefined results to null so the envelope stays JSON-safe', async () => {
    const posted: unknown[] = [];
    const bridge = createModelContextBridge(message => posted.push(message));
    bridge.modelContext.registerTool({ name: 'noop', execute: () => undefined });

    bridge.handleHostMessage({
      source: EV_WEBMCP_HOST_SOURCE,
      kind: 'call',
      requestId: 'request-2',
      name: 'noop',
      args: {},
    });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ kind: 'call-response', ok: true, result: null });
  });

  it('wraps page-side exceptions into error envelopes', async () => {
    const posted: unknown[] = [];
    const bridge = createModelContextBridge(message => posted.push(message));
    bridge.modelContext.registerTool({
      name: 'broken',
      execute: () => {
        throw new Error('catalog offline');
      },
    });

    bridge.handleHostMessage({
      source: EV_WEBMCP_HOST_SOURCE,
      kind: 'call',
      requestId: 'request-3',
      name: 'broken',
      args: {},
    });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({
      source: 'ev-webmcp-page',
      kind: 'call-response',
      requestId: 'request-3',
      ok: false,
      error: 'catalog offline',
      errorCode: 'execution',
    });
  });

  it('rejects results that cannot be serialized to JSON', async () => {
    const posted: unknown[] = [];
    const bridge = createModelContextBridge(message => posted.push(message));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    bridge.modelContext.registerTool({ name: 'cyclic', execute: () => cyclic });

    bridge.handleHostMessage({
      source: EV_WEBMCP_HOST_SOURCE,
      kind: 'call',
      requestId: 'request-4',
      name: 'cyclic',
      args: {},
    });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ ok: false, errorCode: 'serialization' });
  });

  it('answers calls for unknown tools with a not-found envelope', async () => {
    const posted: unknown[] = [];
    const bridge = createModelContextBridge(message => posted.push(message));

    bridge.handleHostMessage({
      source: EV_WEBMCP_HOST_SOURCE,
      kind: 'call',
      requestId: 'request-5',
      name: 'ghost',
      args: {},
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ok: false, errorCode: 'not-found' });
  });

  it('ignores unrelated window messages', () => {
    const posted: unknown[] = [];
    const bridge = createModelContextBridge(message => posted.push(message));
    bridge.handleHostMessage({ source: 'other-extension', kind: 'call' });
    bridge.handleHostMessage('not-an-object');
    bridge.handleHostMessage(null);
    expect(posted).toHaveLength(0);
  });
});
