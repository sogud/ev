import { describe, expect, test } from 'vitest';

import {
  BrowserCommandSchema,
  BrowserControlRequestSchema,
  BrowserControlResponseSchema,
  BrowserDownloadDispatchSchema,
  BrowserDownloadStatusSchema,
  BrowserSessionCommandResultSchema,
  BrowserSessionReleaseResultSchema,
  BrowserSessionSnapshotSchema,
  CreateTaskRequestSchema,
  DesktopToExtensionMessageSchema,
  EV_PROTOCOL_VERSION,
  ExtensionToDesktopMessageSchema,
  PageContextSchema,
  RuntimeDescriptorSchema,
  RuntimeEventSchema,
  RuntimeSessionRefSchema,
  SiteRecipeDefinitionSchema,
  SiteRecipeRunResultSchema,
  SiteRecipeSchema,
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
      { action: 'bookmarks.list', maxNodes: 5_000 },
      { action: 'bookmarks.search', query: 'EV', maxNodes: 5_000 },
      {
        action: 'bookmarks.create',
        title: 'EV docs',
        url: 'https://example.com',
        parentId: '1',
      },
      { action: 'bookmarks.update', id: '42', title: 'Renamed' },
      { action: 'bookmarks.move', id: '42', parentId: '2', index: 0 },
      { action: 'bookmarks.remove', id: '42' },
      { action: 'bookmarks.removeTree', id: '43', confirm: 'REMOVE_BOOKMARK_TREE' },
      { action: 'bookmarks.export' },
      {
        action: 'bookmarks.restore',
        tree: [{ title: 'Bookmarks bar', children: [{ title: 'EV', url: 'https://ev.dev' }] }],
        parentId: '2',
        title: 'Recovered',
      },
    ];
    for (const command of commands) {
      expect(BrowserCommandSchema.safeParse(command).success).toBe(true);
    }
    expect(
      BrowserCommandSchema.safeParse({ action: 'page.eval', expression: 'document.cookie' }).success
    ).toBe(false);
    expect(
      BrowserCommandSchema.safeParse({ action: 'bookmarks.removeTree', id: '43' }).success
    ).toBe(false);
    expect(BrowserCommandSchema.safeParse({ action: 'bookmarks.update', id: '42' }).success).toBe(
      false
    );
    expect(BrowserCommandSchema.safeParse({ action: 'bookmarks.move', id: '42' }).success).toBe(
      false
    );
    expect(
      BrowserCommandSchema.safeParse({
        action: 'bookmarks.restore',
        tree: [{ title: 'Mixed', url: 'https://ev.dev', children: [{ title: 'Child' }] }],
      }).success
    ).toBe(false);
    expect(
      BrowserCommandSchema.safeParse({ action: 'page.upload', selector: '#file', filePaths: [] })
        .success
    ).toBe(false);
  });

  test('validates bounded BrowserRun plans', () => {
    const semanticClick = {
      kind: 'command',
      command: {
        action: 'page.click',
        target: { role: 'link', name: '添加隐藏的字词或短语' },
      },
      retry: { attempts: 8, delayMs: 400 },
    };
    const typeItem = {
      kind: 'command',
      command: {
        action: 'page.type',
        target: { role: 'textbox', name: '输入字词或短语' },
        text: { from: 'item' },
        clearFirst: true,
      },
    };
    const run = {
      action: 'browser.run',
      tabId: 12,
      steps: [
        {
          kind: 'forEach',
          id: 'add-words',
          items: ['福不黑', '寻固炮'],
          onError: 'continue',
          steps: [semanticClick, typeItem, { kind: 'wait', timeMs: 300 }],
        },
      ],
    };
    expect(BrowserCommandSchema.safeParse(run).success).toBe(true);

    expect(
      BrowserCommandSchema.safeParse({
        action: 'browser.run',
        steps: [
          {
            kind: 'forEach',
            items: ['outer'],
            steps: [{ kind: 'forEach', items: ['inner'], steps: [semanticClick] }],
          },
        ],
      }).success
    ).toBe(false);
    expect(
      BrowserCommandSchema.safeParse({
        action: 'browser.run',
        steps: [typeItem],
      }).success
    ).toBe(false);

    const oversizedLoop = {
      kind: 'forEach',
      items: Array.from({ length: 100 }, (_, index) => String(index)),
      steps: Array.from({ length: 11 }, () => semanticClick),
    };
    expect(
      BrowserCommandSchema.safeParse({
        action: 'browser.run',
        steps: [oversizedLoop, oversizedLoop],
      }).success
    ).toBe(false);
  });

  test('validates BrowserSession ownership commands and results', () => {
    const sessionId = '3f88e635-1ba1-4e8c-91fd-83d682959f8a';
    const commands = [
      { action: 'windows.open', url: 'https://example.com', focused: false },
      { action: 'tabs.open', url: 'https://example.com/docs', windowId: 9, active: false },
      { action: 'browser.session.create', url: 'https://example.com' },
      { action: 'browser.session.list' },
      { action: 'browser.session.get', sessionId },
      {
        action: 'browser.session.open',
        sessionId,
        url: 'https://example.com/docs',
        active: true,
      },
      { action: 'browser.session.adoptTab', sessionId, tabId: 42 },
      {
        action: 'browser.session.command',
        sessionId,
        command: { action: 'page.snapshot', mode: 'interactive' },
      },
      {
        action: 'browser.session.command',
        sessionId,
        command: {
          action: 'browser.run',
          steps: [{ kind: 'wait', timeMs: 1 }],
        },
      },
      { action: 'browser.session.release', sessionId },
    ];
    for (const command of commands) {
      expect(BrowserCommandSchema.safeParse(command).success).toBe(true);
    }

    expect(
      BrowserCommandSchema.safeParse({
        action: 'browser.session.command',
        sessionId,
        command: { action: 'tabs.close', tabId: 42 },
      }).success
    ).toBe(false);
    expect(
      BrowserCommandSchema.safeParse({
        action: 'browser.session.command',
        sessionId,
        command: { action: 'bookmarks.list' },
      }).success
    ).toBe(false);
    expect(
      BrowserCommandSchema.safeParse({
        action: 'browser.session.command',
        sessionId,
        command: { action: 'browser.session.list' },
      }).success
    ).toBe(false);

    const session = {
      sessionId,
      windowId: 9,
      ownedTabIds: [11, 12],
      borrowedTabIds: [42],
      activeTabId: 42,
    };
    expect(BrowserSessionSnapshotSchema.safeParse(session).success).toBe(true);
    expect(
      BrowserSessionSnapshotSchema.safeParse({
        ...session,
        ownedTabIds: Array.from({ length: 33 }, (_, index) => index),
      }).success
    ).toBe(false);
    expect(
      BrowserSessionCommandResultSchema.safeParse({ sessionId, tabId: 42, result: { nodes: [] } })
        .success
    ).toBe(true);
    expect(
      BrowserSessionReleaseResultSchema.safeParse({
        sessionId,
        released: true,
        closedOwnedTabIds: [11, 12],
        preservedBorrowedTabIds: [42],
      }).success
    ).toBe(true);
  });

  test('validates strict SiteRecipe definitions, lifecycle commands, and results', () => {
    const sessionId = '3f88e635-1ba1-4e8c-91fd-83d682959f8a';
    const muteRecipe = {
      id: 'x.mute-words-english',
      version: 1,
      title: 'Mute words in X',
      description: 'Use reviewed English UI labels.',
      kind: 'x.mute-words',
      domains: ['x.com'],
      pathPrefixes: ['/settings/muted_keywords'],
      targets: {
        add: { role: 'button', name: 'Add' },
        input: { role: 'textbox', name: 'Enter word or phrase' },
        save: { role: 'button', name: 'Save' },
      },
      retry: { attempts: 8, delayMs: 400 },
      waitAfterItemMs: 300,
    };
    const grokRecipe = {
      id: 'x.read-grok-main',
      version: 1,
      title: 'Read Grok conversation',
      description: 'Read bounded main text.',
      kind: 'x.read-grok-conversation',
      domains: ['x.com'],
      pathPrefixes: ['/i/grok/', '/i/grok/share/'],
      scope: 'main',
      defaultMaxChars: 100_000,
    };
    expect(SiteRecipeDefinitionSchema.safeParse(muteRecipe).success).toBe(true);
    expect(SiteRecipeDefinitionSchema.safeParse(grokRecipe).success).toBe(true);
    expect(
      SiteRecipeDefinitionSchema.safeParse({ ...muteRecipe, domains: ['evilx.com'] }).success
    ).toBe(false);
    expect(
      SiteRecipeDefinitionSchema.safeParse({ ...muteRecipe, script: 'document.cookie' }).success
    ).toBe(false);
    expect(
      SiteRecipeDefinitionSchema.safeParse({
        ...muteRecipe,
        targets: { ...muteRecipe.targets, save: { selector: '[data-testid="save"]' } },
      }).success
    ).toBe(false);
    expect(
      SiteRecipeDefinitionSchema.safeParse({ ...muteRecipe, steps: [{ action: 'page.eval' }] })
        .success
    ).toBe(false);

    const approved = {
      ...muteRecipe,
      source: 'user',
      status: 'approved',
      reviewToken: 'a'.repeat(64),
    };
    expect(SiteRecipeSchema.safeParse(approved).success).toBe(true);
    expect(
      SiteRecipeSchema.safeParse({ ...approved, source: 'builtin', status: 'draft' }).success
    ).toBe(false);

    const commands = [
      { action: 'browser.recipe.list' },
      { action: 'browser.recipe.get', recipeId: 'x.mute-words' },
      { action: 'browser.recipe.draft.save', recipe: muteRecipe },
      {
        action: 'browser.recipe.approve',
        recipeId: muteRecipe.id,
        reviewToken: 'a'.repeat(64),
        confirm: 'APPROVE_SITE_RECIPE',
      },
      {
        action: 'browser.recipe.run',
        recipeId: 'x.mute-words',
        sessionId,
        input: { kind: 'x.mute-words', words: ['福不黑', '寻固炮'] },
      },
      {
        action: 'browser.recipe.run',
        recipeId: 'x.read-grok-conversation',
        sessionId,
        input: { kind: 'x.read-grok-conversation', maxChars: 50_000 },
      },
    ];
    commands.forEach(command => expect(BrowserCommandSchema.safeParse(command).success).toBe(true));
    expect(
      BrowserCommandSchema.safeParse({
        action: 'browser.recipe.approve',
        recipeId: muteRecipe.id,
        reviewToken: 'a'.repeat(64),
        confirm: 'YES',
      }).success
    ).toBe(false);
    expect(
      BrowserCommandSchema.safeParse({
        action: 'browser.recipe.run',
        recipeId: 'x.mute-words',
        sessionId,
        input: { kind: 'x.mute-words', words: ['same', 'same'] },
      }).success
    ).toBe(false);

    expect(
      SiteRecipeRunResultSchema.safeParse({
        recipeId: 'x.mute-words',
        version: 1,
        kind: 'x.mute-words',
        status: 'partial',
        output: {
          added: ['福不黑'],
          skipped: ['寻固炮'],
          failed: [{ item: '单身弟弟', message: 'target not found' }],
        },
        summary: { requested: 3, attempted: 2, retries: 1, durationMs: 1000 },
      }).success
    ).toBe(true);
    expect(
      SiteRecipeRunResultSchema.safeParse({
        recipeId: 'x.read-grok-conversation',
        version: 1,
        kind: 'x.read-grok-conversation',
        status: 'completed',
        output: {
          url: 'https://x.com/i/grok/share/abc',
          title: 'Grok',
          text: 'conversation',
          capturedAt: '2026-08-11T00:00:00.000Z',
          truncated: false,
        },
      }).success
    ).toBe(true);
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

  test('allows only atomic commands in Desktop-to-Extension envelopes', () => {
    const envelope = {
      type: 'browser.command',
      id: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
      command: { action: 'tabs.list' },
    };
    expect(DesktopToExtensionMessageSchema.safeParse(envelope).success).toBe(true);
    expect(
      DesktopToExtensionMessageSchema.safeParse({
        ...envelope,
        command: { action: 'browser.run', steps: [{ kind: 'wait', timeMs: 1 }] },
      }).success
    ).toBe(false);
    expect(
      DesktopToExtensionMessageSchema.safeParse({
        ...envelope,
        command: { action: 'browser.session.list' },
      }).success
    ).toBe(false);
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
