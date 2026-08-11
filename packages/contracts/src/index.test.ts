import { describe, expect, test } from 'vitest';

import {
  BrowserCommandSchema,
  BrowserControlRequestSchema,
  BrowserControlResponseSchema,
  BrowserDownloadDispatchSchema,
  BrowserDownloadStatusSchema,
  CreateTaskRequestSchema,
  DesktopToExtensionMessageSchema,
  EV_PROTOCOL_VERSION,
  ExtensionToDesktopMessageSchema,
  PageContextSchema,
  RuntimeDescriptorSchema,
  RuntimeEventSchema,
  RuntimeSessionRefSchema,
} from './index';

describe('EV contracts', () => {
  test('accepts a bounded browser task request', () => {
    const result = CreateTaskRequestSchema.safeParse({
      protocolVersion: EV_PROTOCOL_VERSION,
      requestId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
      source: 'browser-extension',
      prompt: '总结当前页面',
      page: {
        url: 'https://example.com/article',
        title: 'Example article',
        capturedAt: '2026-08-03T10:00:00.000Z',
      },
    });

    expect(result.success).toBe(true);
  });

  test('rejects non-web URLs and oversized selections', () => {
    expect(
      PageContextSchema.safeParse({
        url: 'not a url',
        title: 'Invalid page',
        selection: 'x'.repeat(100_001),
        capturedAt: '2026-08-03T10:00:00.000Z',
      }).success
    ).toBe(false);
  });

  test('allows bounded CDP operations but rejects arbitrary page evaluation', () => {
    const commands = [
      { action: 'browser.capabilities' },
      { action: 'page.snapshot', tabId: 12, mode: 'interactive', maxNodes: 200 },
      { action: 'page.click', selector: '@e12' },
      { action: 'page.hover', selector: '#menu' },
      { action: 'page.press', key: 'Enter' },
      { action: 'page.wait', selector: '[data-ready]', timeoutMs: 5_000 },
      { action: 'page.upload', selector: 'input[type=file]', filePaths: ['/tmp/a.png'] },
      { action: 'page.frames', tabId: 12 },
      { action: 'page.logs', tabId: 12, limit: 20 },
      { action: 'page.network', tabId: 12, limit: 20 },
      { action: 'page.media', tabId: 12, maxItems: 100 },
      { action: 'page.download', tabId: 12, ref: '@m2' },
      { action: 'downloads.status', downloadId: 'local:download-id' },
      {
        action: 'page.emulate',
        tabId: 12,
        enabled: true,
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
      },
      { action: 'page.release', tabId: 12 },
    ];
    for (const command of commands) {
      expect(BrowserCommandSchema.safeParse(command).success).toBe(true);
    }
    expect(
      BrowserCommandSchema.safeParse({ action: 'page.eval', expression: 'document.cookie' }).success
    ).toBe(false);
    expect(
      BrowserCommandSchema.safeParse({ action: 'page.upload', selector: '#file', filePaths: [] })
        .success
    ).toBe(false);
  });

  test('validates bounded media download handoffs and status', () => {
    expect(
      BrowserDownloadDispatchSchema.safeParse({
        backend: 'external',
        url: 'https://cdn.example.com/video/master.m3u8?signature=secret',
        pageUrl: 'https://example.com/watch',
        mediaKind: 'stream',
      }).success
    ).toBe(true);
    expect(
      BrowserDownloadDispatchSchema.safeParse({
        backend: 'external',
        url: 'file:///tmp/video.mp4',
        pageUrl: 'https://example.com/watch',
        mediaKind: 'video',
      }).success
    ).toBe(false);
    expect(
      BrowserDownloadStatusSchema.safeParse({
        downloadId: 'local:download-id',
        backend: 'local',
        state: 'in_progress',
      }).success
    ).toBe(true);
  });

  test('validates authenticated local CLI envelopes', () => {
    const request = {
      protocolVersion: EV_PROTOCOL_VERSION,
      requestId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
      token: 'a'.repeat(43),
      command: { action: 'page.snapshot', mode: 'interactive' },
    };
    expect(BrowserControlRequestSchema.safeParse(request).success).toBe(true);
    expect(
      BrowserControlRequestSchema.safeParse({ ...request, command: { action: 'host.status' } })
        .success
    ).toBe(true);
    expect(
      BrowserControlRequestSchema.safeParse({ ...request, command: { action: 'host.shutdown' } })
        .success
    ).toBe(true);
    expect(BrowserControlRequestSchema.safeParse({ ...request, token: 'short' }).success).toBe(
      false
    );

    expect(
      BrowserControlResponseSchema.safeParse({
        requestId: request.requestId,
        success: true,
        data: { nodes: [] },
      }).success
    ).toBe(true);
    expect(
      BrowserControlResponseSchema.safeParse({
        requestId: request.requestId,
        success: false,
        error: { code: 'BROWSER_DISCONNECTED', message: 'EV Browser is not connected' },
      }).success
    ).toBe(true);
  });

  test('validates Desktop command envelopes', () => {
    expect(
      DesktopToExtensionMessageSchema.safeParse({
        type: 'browser.command',
        id: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
        command: { action: 'tabs.list' },
      }).success
    ).toBe(true);
  });

  test('validates automatic pairing request and approval messages', () => {
    const browserId = '3f88e635-1ba1-4e8c-91fd-83d682959f8a';
    expect(
      ExtensionToDesktopMessageSchema.safeParse({
        type: 'bridge.pair.request',
        protocolVersion: EV_PROTOCOL_VERSION,
        browserId,
        browserName: 'Chrome',
        extensionVersion: '1.0.0',
      }).success
    ).toBe(true);
    expect(
      DesktopToExtensionMessageSchema.safeParse({
        type: 'bridge.pair.approved',
        protocolVersion: EV_PROTOCOL_VERSION,
        pairingToken: 'a'.repeat(43),
      }).success
    ).toBe(true);
    expect(DesktopToExtensionMessageSchema.safeParse({ type: 'bridge.pair.pending' }).success).toBe(
      true
    );
  });

  test('validates runtime descriptors, native session refs, and normalized events', () => {
    expect(
      RuntimeDescriptorSchema.safeParse({
        id: 'pi',
        name: 'Pi',
        availability: 'available',
        version: '0.83.0',
        capabilities: {
          models: true,
          thinkingLevels: true,
          tools: true,
          resumeSession: true,
          structuredEvents: true,
          permissionModes: false,
        },
      }).success
    ).toBe(true);
    expect(
      RuntimeSessionRefSchema.safeParse({
        runtimeId: 'codex',
        nativeId: '019f8cfe-b436-7c21-80b7-005def641e78',
      }).success
    ).toBe(true);
    expect(
      RuntimeEventSchema.safeParse({
        type: 'message',
        id: 'message-1',
        role: 'assistant',
        content: 'done',
        timestamp: Date.now(),
      }).success
    ).toBe(true);
    expect(RuntimeSessionRefSchema.safeParse({ runtimeId: 'claude', nativeId: 'x' }).success).toBe(
      false
    );
  });

  test('validates extension pairing messages at the Desktop boundary', () => {
    expect(
      ExtensionToDesktopMessageSchema.safeParse({
        type: 'bridge.hello',
        protocolVersion: EV_PROTOCOL_VERSION,
        browserId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
        browserName: 'Chrome',
        extensionVersion: '1.0.0',
        pairingToken: 'a-secure-pairing-token',
      }).success
    ).toBe(true);
    expect(
      ExtensionToDesktopMessageSchema.safeParse({
        type: 'bridge.hello',
        protocolVersion: EV_PROTOCOL_VERSION,
        browserId: 'not-a-uuid',
        browserName: 'Chrome',
        extensionVersion: '1.0.0',
        pairingToken: 'short',
      }).success
    ).toBe(false);
  });
});
