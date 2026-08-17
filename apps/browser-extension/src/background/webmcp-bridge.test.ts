import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PageBridgeUnavailableError,
  callPageWebMcpTool,
  listPageWebMcpTools,
  requestActionHighlight,
} from './webmcp-bridge';

describe('background page bridge helpers', () => {
  const sendMessage = vi.fn();

  beforeEach(() => {
    sendMessage.mockReset();
    globalThis.chrome = {
      tabs: { sendMessage },
    } as unknown as typeof chrome;
  });

  it('lists registered tools and drops malformed entries', async () => {
    sendMessage.mockResolvedValue({
      tools: [{ name: 'search', description: 'Search' }, { name: 42 }, null, 'garbage'],
    });

    await expect(listPageWebMcpTools(7)).resolves.toEqual([
      { name: 'search', description: 'Search' },
    ]);
    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'ev-webmcp.listTools' });
  });

  it('throws a clear error when the content script is missing', async () => {
    sendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.')
    );
    await expect(listPageWebMcpTools(7)).rejects.toThrow(PageBridgeUnavailableError);
    await expect(listPageWebMcpTools(7)).rejects.toThrow(/reload the page/);
  });

  it('wraps a missing bridge into a callTool error envelope instead of throwing', async () => {
    sendMessage.mockRejectedValue(new Error('No tab with id 7'));
    await expect(callPageWebMcpTool(7, 'tool', {}, 1_000)).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('unavailable'),
      errorCode: 'bridge-unavailable',
    });
  });

  it('passes call parameters through and returns the page outcome', async () => {
    sendMessage.mockResolvedValue({ ok: true, result: { items: [] } });
    await expect(callPageWebMcpTool(7, 'search', { query: 'kb' }, 5_000)).resolves.toEqual({
      ok: true,
      result: { items: [] },
    });
    expect(sendMessage).toHaveBeenCalledWith(7, {
      type: 'ev-webmcp.callTool',
      name: 'search',
      args: { query: 'kb' },
      timeoutMs: 5_000,
    });
  });

  it('flags invalid content-script responses', async () => {
    sendMessage.mockResolvedValue({ unexpected: true });
    await expect(callPageWebMcpTool(7, 'tool', {}, 1_000)).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('invalid response'),
      errorCode: 'invalid-response',
    });
  });

  it('keeps highlight requests best-effort', async () => {
    sendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.')
    );
    await expect(requestActionHighlight(7, '#save', 'click')).resolves.toBeUndefined();

    sendMessage.mockResolvedValue({ highlighted: true });
    await requestActionHighlight(7, '#save', 'click');
    expect(sendMessage).toHaveBeenLastCalledWith(7, {
      type: 'ev-action.highlight',
      selector: '#save',
      label: 'click',
    });
  });
});
