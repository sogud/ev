import { describe, expect, it, vi } from 'vitest';
import { BrowserCommandExecutor } from '../browser-command-executor';
import type { BrowserBridgeService } from '../browser-bridge-service';
import type { MediaDownloadService } from '../media-download-service';

describe('BrowserCommandExecutor', () => {
  it('normalizes Chrome download IDs and routes local status without using the bridge', async () => {
    const bridge = {
      sendCommand: vi.fn(async () => ({ backend: 'chrome', downloadId: 42 })),
    } as unknown as BrowserBridgeService;
    const downloads = {
      start: vi.fn(),
      status: vi.fn(() => ({
        downloadId: 'local:job',
        backend: 'local',
        state: 'complete',
        filename: '/tmp/EV/video.mp4',
      })),
    } as unknown as MediaDownloadService;
    const executor = new BrowserCommandExecutor(bridge, downloads);

    await expect(
      executor.sendCommand({ action: 'page.download', tabId: 7, ref: '@m1' })
    ).resolves.toEqual({
      downloadId: 'chrome:42',
      backend: 'chrome',
      state: 'in_progress',
    });
    await expect(
      executor.sendCommand({ action: 'downloads.status', downloadId: 'local:job' })
    ).resolves.toMatchObject({ state: 'complete' });
    expect(bridge.sendCommand).toHaveBeenCalledOnce();
  });

  it('starts a local helper job for streaming media', async () => {
    const dispatch = {
      backend: 'external' as const,
      mediaKind: 'stream' as const,
      pageUrl: 'https://example.com/watch',
      url: 'https://cdn.example.com/master.m3u8',
    };
    const bridge = {
      sendCommand: vi.fn(async () => dispatch),
    } as unknown as BrowserBridgeService;
    const downloads = {
      start: vi.fn(async () => ({
        downloadId: 'local:job',
        backend: 'local',
        state: 'in_progress',
      })),
    } as unknown as MediaDownloadService;
    const executor = new BrowserCommandExecutor(bridge, downloads);

    await expect(
      executor.sendCommand({ action: 'page.download', tabId: 7, ref: '@m2' })
    ).resolves.toMatchObject({ downloadId: 'local:job', state: 'in_progress' });
    expect(downloads.start).toHaveBeenCalledWith(dispatch);
  });
});
