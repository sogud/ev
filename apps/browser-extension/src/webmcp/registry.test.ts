import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EV_WEBMCP_HOST_SOURCE, EV_WEBMCP_PAGE_SOURCE } from './protocol';
import { WebMcpRegistry } from './registry';

describe('WebMCP content-script registry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks registrations and unregistrations posted by the page', () => {
    const registry = new WebMcpRegistry();

    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'register',
      tool: { name: 'search', description: 'Search' },
    });
    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'register',
      tool: { name: 'add_to_cart', inputSchema: { type: 'object' } },
    });
    expect(registry.list()).toEqual([
      { name: 'search', description: 'Search' },
      { name: 'add_to_cart', inputSchema: { type: 'object' } },
    ]);

    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'unregister',
      name: 'search',
    });
    expect(registry.list()).toEqual([{ name: 'add_to_cart', inputSchema: { type: 'object' } }]);
  });

  it('ignores malformed or foreign window messages', () => {
    const registry = new WebMcpRegistry();
    registry.handlePageMessage({
      source: 'another-extension',
      kind: 'register',
      tool: { name: 'x' },
    });
    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'register',
      tool: { name: 'bad name' },
    });
    registry.handlePageMessage({ source: EV_WEBMCP_PAGE_SOURCE, kind: 'register', tool: {} });
    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'register',
      tool: { name: 42 },
    });
    registry.handlePageMessage(null);
    registry.handlePageMessage('register');
    expect(registry.list()).toEqual([]);
  });

  it('returns an empty list when the page registered nothing', () => {
    expect(new WebMcpRegistry().list()).toEqual([]);
  });

  it('caps the tool table at 128 registrations', () => {
    const registry = new WebMcpRegistry();
    for (let index = 0; index < 130; index += 1) {
      registry.handlePageMessage({
        source: EV_WEBMCP_PAGE_SOURCE,
        kind: 'register',
        tool: { name: `tool_${index}` },
      });
    }
    expect(registry.list()).toHaveLength(128);
  });

  it('answers calls for missing tools synchronously with not-found', async () => {
    const registry = new WebMcpRegistry();
    const postToPage = vi.fn();
    await expect(registry.callTool('ghost', {}, 1_000, 'request-1', postToPage)).resolves.toEqual({
      ok: false,
      error: 'WebMCP tool not found: ghost',
      errorCode: 'not-found',
    });
    expect(postToPage).not.toHaveBeenCalled();
  });

  it('round-trips a call through the page and resolves with the result', async () => {
    const registry = new WebMcpRegistry();
    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'register',
      tool: { name: 'echo' },
    });

    const postToPage = vi.fn();
    const pending = registry.callTool('echo', { value: 3 }, 5_000, 'request-2', postToPage);
    expect(postToPage).toHaveBeenCalledWith({
      source: EV_WEBMCP_HOST_SOURCE,
      kind: 'call',
      requestId: 'request-2',
      name: 'echo',
      args: { value: 3 },
    });

    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'call-response',
      requestId: 'request-2',
      ok: true,
      result: { value: 6 },
    });
    await expect(pending).resolves.toEqual({ ok: true, result: { value: 6 } });
  });

  it('enforces the call timeout with an error envelope', async () => {
    const registry = new WebMcpRegistry();
    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'register',
      tool: { name: 'slow' },
    });

    const pending = registry.callTool('slow', {}, 2_000, 'request-3', vi.fn());
    await vi.advanceTimersByTimeAsync(1_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'WebMCP tool call timed out after 2000ms',
      errorCode: 'timeout',
    });

    // A late page response for the timed-out request is ignored.
    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'call-response',
      requestId: 'request-3',
      ok: true,
      result: 'late',
    });
  });

  it('propagates page-side error envelopes', async () => {
    const registry = new WebMcpRegistry();
    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'register',
      tool: { name: 'broken' },
    });

    const pending = registry.callTool('broken', {}, 5_000, 'request-4', vi.fn());
    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'call-response',
      requestId: 'request-4',
      ok: false,
      error: 'catalog offline',
      errorCode: 'execution',
    });
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'catalog offline',
      errorCode: 'execution',
    });
  });

  it('clears pending calls when the bridge goes away', async () => {
    const registry = new WebMcpRegistry();
    registry.handlePageMessage({
      source: EV_WEBMCP_PAGE_SOURCE,
      kind: 'register',
      tool: { name: 'pending-tool' },
    });

    const pending = registry.callTool('pending-tool', {}, 5_000, 'request-5', vi.fn());
    registry.clearPendingCalls('page navigated');
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'page navigated',
      errorCode: 'bridge-unavailable',
    });
  });
});
