import { z } from 'zod';

import { EV_PROTOCOL_VERSION } from './protocol';

const TabIdSchema = z.number().int().nonnegative();
const WindowIdSchema = z.number().int().nonnegative();
const TabGroupIdSchema = z.number().int().nonnegative();
const FrameIdSchema = z.string().trim().min(1).max(256);
const BrowserSessionIdSchema = z.string().uuid();
export const BrowserIdSchema = z.string().uuid();
export type BrowserId = z.infer<typeof BrowserIdSchema>;

/**
 * Optional explicit target browser. A Host can hold several extension
 * connections (one per Chrome profile) at once; when omitted the Host routes
 * to the only online connection, or to the most recently connected one.
 */
const BrowserTargetSchema = z.object({ browserId: BrowserIdSchema.optional() });
const ChromeSessionIdSchema = z.string().trim().min(1).max(512);
const BrowserDownloadIdSchema = z.string().regex(/^chrome:\d+$/);
const CoordinateSchema = z.number().finite().min(0).max(100_000);
const ScrollDeltaSchema = z.number().finite().min(-100_000).max(100_000);
const MouseButtonSchema = z.enum(['left', 'right', 'middle']);
const WebUrlSchema = z
  .string()
  .url()
  .max(4096)
  .refine(
    value => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    {
      message: 'Only HTTP(S) URLs are supported',
    }
  );

const SelectorSchema = z.string().trim().min(1).max(2048);
const WebMcpToolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/, 'WebMCP tool names use letters, digits, dot, dash, underscore');
const WebMcpToolArgsSchema = z.record(z.string().max(512), z.unknown());
const MediaRefSchema = z.string().regex(/^@m[1-9]\d*$/);
const BoundedLimitSchema = z.number().int().min(1).max(1_000);
const BookmarkIdSchema = z.string().trim().min(1).max(128);
const BookmarkTitleSchema = z.string().trim().min(1).max(1024);
const BookmarkUrlSchema = z.string().min(1).max(100_000);
const BookmarkLimitSchema = z.number().int().min(1).max(50_000);

/** Backup/restore tree node: ids are omitted, structure is title/url/children. */
export interface BookmarkBackupNode {
  title: string;
  url?: string;
  children?: BookmarkBackupNode[];
}

const BookmarkBackupNodeSchema: z.ZodType<BookmarkBackupNode> = z.lazy(() =>
  z
    .object({
      title: z.string().max(1024),
      url: BookmarkUrlSchema.optional(),
      children: z.array(BookmarkBackupNodeSchema).max(10_000).optional(),
    })
    .refine(node => !(node.url && node.children?.length), {
      message: 'A bookmark backup node cannot be both a URL and a folder',
    })
);
const NamedKeySchema = z.enum([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Insert',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
]);
const KeySchema = z.union([NamedKeySchema, z.string().regex(/^[a-zA-Z0-9]$/)]);

const BrowserCommandUnionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('browser.capabilities') }),
  z.object({ action: z.literal('windows.list') }),
  z.object({
    action: z.literal('windows.open'),
    url: WebUrlSchema,
    focused: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('windows.update'),
    windowId: WindowIdSchema,
    focused: z.boolean().optional(),
    state: z.enum(['normal', 'minimized', 'maximized', 'fullscreen']).optional(),
    left: z.number().int().min(-100_000).max(100_000).optional(),
    top: z.number().int().min(-100_000).max(100_000).optional(),
    width: z.number().int().min(100).max(100_000).optional(),
    height: z.number().int().min(100).max(100_000).optional(),
  }),
  z.object({ action: z.literal('windows.close'), windowId: WindowIdSchema }),
  z.object({ action: z.literal('tabs.list') }),
  z.object({ action: z.literal('tabs.get'), tabId: TabIdSchema }),
  z.object({
    action: z.literal('tabs.open'),
    url: WebUrlSchema,
    windowId: WindowIdSchema.optional(),
    active: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('tabs.update'),
    tabId: TabIdSchema,
    url: WebUrlSchema.optional(),
    active: z.boolean().optional(),
    pinned: z.boolean().optional(),
    muted: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('tabs.move'),
    tabId: TabIdSchema,
    windowId: WindowIdSchema.optional(),
    index: z.number().int().min(-1).max(100_000),
  }),
  z.object({ action: z.literal('tabs.duplicate'), tabId: TabIdSchema }),
  z.object({ action: z.literal('tabs.discard'), tabId: TabIdSchema }),
  z.object({ action: z.literal('tabs.close'), tabId: TabIdSchema }),
  z.object({ action: z.literal('tabs.activate'), tabId: TabIdSchema }),
  z.object({ action: z.literal('tabGroups.list'), windowId: WindowIdSchema.optional() }),
  z.object({
    action: z.literal('tabGroups.add'),
    groupId: TabGroupIdSchema,
    tabIds: z.array(TabIdSchema).min(1).max(100),
  }),
  z.object({
    action: z.literal('tabGroups.create'),
    tabIds: z.array(TabIdSchema).min(1).max(100),
    windowId: WindowIdSchema.optional(),
    title: z.string().trim().min(1).max(256).optional(),
    color: z
      .enum(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'])
      .optional(),
    collapsed: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('tabGroups.update'),
    groupId: TabGroupIdSchema,
    title: z.string().trim().min(1).max(256).optional(),
    color: z
      .enum(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'])
      .optional(),
    collapsed: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('tabGroups.ungroup'),
    tabIds: z.array(TabIdSchema).min(1).max(100),
  }),
  z.object({
    action: z.literal('page.navigate'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    url: WebUrlSchema,
  }),
  z.object({
    action: z.literal('page.history'),
    tabId: TabIdSchema.optional(),
    operation: z.enum(['back', 'forward', 'reload', 'stop']),
  }),
  z.object({
    action: z.literal('page.context'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    scope: z.enum(['body', 'main']).optional(),
    maxChars: z.number().int().min(1).max(100_000).optional(),
  }),
  z.object({
    action: z.literal('page.snapshot'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    mode: z.enum(['full', 'interactive']).optional(),
    maxNodes: BoundedLimitSchema.optional(),
    maxChars: z.number().int().min(1).max(200_000).optional(),
  }),
  z.object({
    action: z.literal('page.click'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    selector: SelectorSchema,
    button: MouseButtonSchema.optional(),
    clickCount: z.number().int().min(1).max(2).optional(),
    waitFor: z.enum(['navigation', 'networkIdle', 'popup', 'download']).optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
  }),
  z.object({
    action: z.literal('page.type'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    selector: SelectorSchema,
    text: z.string().max(100_000),
    clearFirst: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('page.setChecked'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    selector: SelectorSchema,
    checked: z.boolean(),
  }),
  z.object({
    action: z.literal('page.select'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    selector: SelectorSchema,
    values: z.array(z.string().max(10_000)).min(1).max(100),
  }),
  z.object({
    action: z.literal('page.drag'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    sourceSelector: SelectorSchema,
    targetSelector: SelectorSchema,
  }),
  z.object({
    action: z.literal('page.focus'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    selector: SelectorSchema,
  }),
  z.object({
    action: z.literal('page.inspect'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    selector: SelectorSchema,
    maxChars: z.number().int().min(1).max(10_000).optional(),
  }),
  z.object({
    action: z.literal('page.hover'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    selector: SelectorSchema,
  }),
  z.object({
    action: z.literal('page.press'),
    tabId: TabIdSchema.optional(),
    key: KeySchema,
    modifiers: z
      .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
      .max(4)
      .optional(),
  }),
  z.object({
    action: z.literal('page.pointer'),
    tabId: TabIdSchema.optional(),
    type: z.enum(['move', 'down', 'up', 'click']),
    x: CoordinateSchema,
    y: CoordinateSchema,
    button: MouseButtonSchema.optional(),
    clickCount: z.number().int().min(1).max(2).optional(),
  }),
  z.object({
    action: z.literal('page.scroll'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
    distance: z.number().int().min(1).max(100_000).optional(),
    selector: SelectorSchema.optional(),
    deltaX: ScrollDeltaSchema.optional(),
    deltaY: ScrollDeltaSchema.optional(),
  }),
  z.object({
    action: z.literal('page.wait'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    condition: z
      .enum(['target', 'time', 'navigation', 'networkIdle', 'popup', 'download'])
      .optional(),
    selector: SelectorSchema.optional(),
    timeMs: z.number().int().min(0).max(30_000).optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
    idleMs: z.number().int().min(100).max(5_000).optional(),
  }),
  z.object({
    action: z.literal('page.dialog.respond'),
    tabId: TabIdSchema.optional(),
    accept: z.boolean(),
    promptText: z.string().max(10_000).optional(),
  }),
  z.object({
    action: z.literal('page.screenshot'),
    tabId: TabIdSchema.optional(),
    format: z.enum(['png', 'jpeg']).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    fullPage: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('page.upload'),
    tabId: TabIdSchema.optional(),
    frameId: FrameIdSchema.optional(),
    selector: SelectorSchema,
    filePaths: z.array(z.string().trim().min(1).max(4096)).min(1).max(10),
  }),
  z.object({ action: z.literal('page.frames'), tabId: TabIdSchema.optional() }),
  z.object({
    action: z.literal('page.subtitles'),
    tabId: TabIdSchema.optional(),
    operation: z.enum(['read', 'download']).default('read'),
    language: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    includeAutomatic: z.boolean().default(true),
    format: z.enum(['vtt', 'srt']).default('vtt'),
    maxChars: z.number().int().min(1_000).max(200_000).default(100_000),
    fallback: z.enum(['none', 'local-asr']).default('none'),
    confirm: z.literal('RUN_LOCAL_ASR').optional(),
    /**
     * Read cookies from a browser profile and pass them to the subtitle
     * extractor. Required for some sites (e.g. Bilibili AI subtitles) where
     * subtitle tracks are only returned to logged-in users. Anonymous by
     * default to keep the Host from touching browser storage unexpectedly.
     */
    cookiesFromBrowser: z.enum(['chrome', 'edge', 'firefox', 'safari']).optional(),
  }),
  z.object({
    action: z.literal('page.media'),
    tabId: TabIdSchema.optional(),
    maxItems: z.number().int().min(1).max(500).optional(),
  }),
  z.object({
    action: z.literal('page.download'),
    tabId: TabIdSchema.optional(),
    ref: MediaRefSchema,
  }),
  z.object({
    action: z.literal('downloads.status'),
    downloadId: z.string().trim().min(1).max(100),
  }),
  z.object({
    action: z.literal('downloads.list'),
    query: z.string().trim().min(1).max(1_000).optional(),
    state: z.enum(['in_progress', 'complete', 'interrupted']).optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
  }),
  z.object({ action: z.literal('downloads.pause'), downloadId: BrowserDownloadIdSchema }),
  z.object({ action: z.literal('downloads.resume'), downloadId: BrowserDownloadIdSchema }),
  z.object({ action: z.literal('downloads.cancel'), downloadId: BrowserDownloadIdSchema }),
  z.object({ action: z.literal('downloads.open'), downloadId: BrowserDownloadIdSchema }),
  z.object({ action: z.literal('downloads.show'), downloadId: BrowserDownloadIdSchema }),
  z.object({
    action: z.literal('downloads.remove'),
    downloadId: BrowserDownloadIdSchema,
    mode: z.enum(['file', 'record', 'both']),
    confirm: z.literal('REMOVE_DOWNLOAD'),
  }),
  z.object({
    action: z.literal('history.search'),
    text: z.string().max(1_000).optional(),
    startTime: z.number().finite().nonnegative().optional(),
    endTime: z.number().finite().nonnegative().optional(),
    maxResults: z.number().int().min(1).max(10_000).optional(),
  }),
  z.object({ action: z.literal('history.getVisits'), url: WebUrlSchema }),
  z.object({
    action: z.literal('history.remove'),
    target: z.discriminatedUnion('type', [
      z.object({ type: z.literal('url'), url: WebUrlSchema }),
      z.object({
        type: z.literal('range'),
        startTime: z.number().finite().nonnegative(),
        endTime: z.number().finite().nonnegative(),
      }),
      z.object({ type: z.literal('all') }),
    ]),
    confirm: z.literal('REMOVE_BROWSER_HISTORY'),
  }),
  z.object({
    action: z.literal('sessions.recent'),
    maxResults: z.number().int().min(1).max(25).optional(),
  }),
  z.object({
    action: z.literal('sessions.restore'),
    sessionId: ChromeSessionIdSchema.optional(),
  }),
  z.object({ action: z.literal('zoom.get'), tabId: TabIdSchema.optional() }),
  z.object({
    action: z.literal('zoom.set'),
    tabId: TabIdSchema.optional(),
    factor: z.number().finite().min(0.25).max(5),
  }),
  z.object({
    action: z.literal('page.logs'),
    tabId: TabIdSchema.optional(),
    limit: BoundedLimitSchema.optional(),
    level: z.enum(['verbose', 'info', 'warning', 'error']).optional(),
  }),
  z.object({
    action: z.literal('page.network'),
    tabId: TabIdSchema.optional(),
    limit: BoundedLimitSchema.optional(),
    urlIncludes: z.string().max(2048).optional(),
  }),
  z.object({
    action: z.literal('page.emulate'),
    tabId: TabIdSchema.optional(),
    enabled: z.boolean(),
    width: z.number().int().min(200).max(7680).optional(),
    height: z.number().int().min(200).max(7680).optional(),
    deviceScaleFactor: z.number().min(0.5).max(8).optional(),
    mobile: z.boolean().optional(),
    touch: z.boolean().optional(),
  }),
  z.object({ action: z.literal('page.release'), tabId: TabIdSchema.optional() }),
  z.object({
    action: z.literal('page.webmcp.listTools'),
    tabId: TabIdSchema.optional(),
  }),
  z.object({
    action: z.literal('page.webmcp.callTool'),
    tabId: TabIdSchema.optional(),
    name: WebMcpToolNameSchema,
    args: WebMcpToolArgsSchema.optional(),
    timeoutMs: z.number().int().min(100).max(60_000).optional(),
  }),
  z.object({
    action: z.literal('bookmarks.list'),
    maxNodes: BookmarkLimitSchema.optional(),
  }),
  z.object({
    action: z.literal('bookmarks.search'),
    query: z.string().trim().min(1).max(512),
    maxNodes: BookmarkLimitSchema.optional(),
  }),
  z.object({
    action: z.literal('bookmarks.create'),
    title: BookmarkTitleSchema,
    url: WebUrlSchema.optional(),
    parentId: BookmarkIdSchema.optional(),
  }),
  z.object({
    action: z.literal('bookmarks.update'),
    id: BookmarkIdSchema,
    title: BookmarkTitleSchema.optional(),
    url: WebUrlSchema.optional(),
  }),
  z.object({
    action: z.literal('bookmarks.move'),
    id: BookmarkIdSchema,
    parentId: BookmarkIdSchema.optional(),
    index: z.number().int().nonnegative().optional(),
  }),
  z.object({ action: z.literal('bookmarks.remove'), id: BookmarkIdSchema }),
  z.object({
    action: z.literal('bookmarks.removeTree'),
    id: BookmarkIdSchema,
    confirm: z.literal('REMOVE_BOOKMARK_TREE'),
  }),
  z.object({ action: z.literal('bookmarks.export') }),
  z.object({
    action: z.literal('bookmarks.restore'),
    tree: z.array(BookmarkBackupNodeSchema).min(1),
    parentId: BookmarkIdSchema.optional(),
    title: BookmarkTitleSchema.optional(),
  }),
]);

export const BrowserAtomicCommandSchema = BrowserCommandUnionSchema.and(
  BrowserTargetSchema
).superRefine((command, context) => {
  if (
    command.action === 'windows.update' &&
    command.focused === undefined &&
    command.state === undefined &&
    command.left === undefined &&
    command.top === undefined &&
    command.width === undefined &&
    command.height === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Window update requires at least one property',
    });
  }
  if (
    command.action === 'tabs.update' &&
    command.url === undefined &&
    command.active === undefined &&
    command.pinned === undefined &&
    command.muted === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Tab update requires at least one property',
    });
  }
  if (
    command.action === 'tabGroups.update' &&
    command.title === undefined &&
    command.color === undefined &&
    command.collapsed === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Tab group update requires at least one property',
    });
  }
  if (
    command.action === 'page.scroll' &&
    command.direction === undefined &&
    command.selector === undefined &&
    command.deltaX === undefined &&
    command.deltaY === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Page scroll requires a direction, target, or delta',
    });
  }
  if (
    command.action === 'page.wait' &&
    command.condition === 'target' &&
    command.selector === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Target wait requires a selector',
    });
  }
  if (
    command.action === 'history.remove' &&
    command.target.type === 'range' &&
    command.target.startTime >= command.target.endTime
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'History range endTime must be greater than startTime',
    });
  }
  if (
    command.action === 'history.search' &&
    command.startTime !== undefined &&
    command.endTime !== undefined &&
    command.startTime >= command.endTime
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'History search endTime must be greater than startTime',
    });
  }
  if (
    command.action === 'page.subtitles' &&
    command.fallback === 'local-asr' &&
    command.confirm !== 'RUN_LOCAL_ASR'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Local ASR fallback requires confirm: RUN_LOCAL_ASR',
    });
  }
  if (
    command.action === 'bookmarks.update' &&
    command.title === undefined &&
    command.url === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Bookmark update requires a title or URL',
    });
  }
  if (
    command.action === 'bookmarks.move' &&
    command.parentId === undefined &&
    command.index === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Bookmark move requires a parentId or index',
    });
  }
});

export type BrowserAtomicCommand = z.infer<typeof BrowserAtomicCommandSchema>;

export const BrowserPageContextResultSchema = z.object({
  url: WebUrlSchema,
  title: z.string().max(1_000),
  selection: z.string().max(100_000).optional(),
  text: z.string().max(100_000),
  capturedAt: z.string().datetime(),
});

export type BrowserPageContextResult = z.infer<typeof BrowserPageContextResultSchema>;

/** A tool that a page registered through the WebMCP bridge (`navigator.modelContext`). */
export const BrowserWebMcpToolSchema = z
  .object({
    name: WebMcpToolNameSchema,
    description: z.string().max(4_096).optional(),
    inputSchema: z.record(z.string().max(512), z.unknown()).optional(),
  })
  .strict();

export type BrowserWebMcpTool = z.infer<typeof BrowserWebMcpToolSchema>;

export const BrowserWebMcpListResultSchema = z.object({
  tabId: TabIdSchema,
  tools: z.array(BrowserWebMcpToolSchema).max(128),
});

export type BrowserWebMcpListResult = z.infer<typeof BrowserWebMcpListResultSchema>;

export const BrowserWebMcpErrorCodeSchema = z.enum([
  'bridge-unavailable',
  'not-found',
  'timeout',
  'execution',
  'serialization',
  'invalid-response',
]);

export type BrowserWebMcpErrorCode = z.infer<typeof BrowserWebMcpErrorCodeSchema>;

/**
 * WebMCP tool invocation always resolves to a JSON envelope: tool output and
 * failures (missing tool, timeout, page-side exceptions) are both serialized.
 */
export const BrowserWebMcpCallResultSchema = z
  .object({
    tabId: TabIdSchema,
    name: WebMcpToolNameSchema,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(10_000).optional(),
    errorCode: BrowserWebMcpErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.ok && result.result === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result'],
        message: 'Successful WebMCP calls require a result value',
      });
    }
    if (!result.ok && result.error === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error'],
        message: 'Failed WebMCP calls require an error message',
      });
    }
  });

export type BrowserWebMcpCallResult = z.infer<typeof BrowserWebMcpCallResultSchema>;

export const BrowserSemanticTargetSchema = z
  .object({
    role: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(1024),
    exact: z.boolean().optional(),
    index: z.number().int().min(0).max(99).optional(),
  })
  .strict();

export const BrowserRunTargetSchema = z.union([
  z.object({ selector: SelectorSchema }).strict(),
  BrowserSemanticTargetSchema,
]);

const BrowserRunTextSchema = z.union([
  z.string().max(100_000),
  z.object({ from: z.literal('item') }),
]);

export const BrowserRunRetrySchema = z
  .object({
    attempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

const BrowserRunAtomicStepCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('page.navigate'),
    frameId: FrameIdSchema.optional(),
    url: WebUrlSchema,
  }),
  z.object({
    action: z.literal('page.history'),
    operation: z.enum(['back', 'forward', 'reload', 'stop']),
  }),
  z.object({
    action: z.literal('page.click'),
    frameId: FrameIdSchema.optional(),
    target: BrowserRunTargetSchema,
    button: MouseButtonSchema.optional(),
    clickCount: z.number().int().min(1).max(2).optional(),
    waitFor: z.enum(['navigation', 'networkIdle', 'popup', 'download']).optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
  }),
  z.object({
    action: z.literal('page.type'),
    frameId: FrameIdSchema.optional(),
    target: BrowserRunTargetSchema,
    text: BrowserRunTextSchema,
    clearFirst: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('page.setChecked'),
    frameId: FrameIdSchema.optional(),
    target: BrowserRunTargetSchema,
    checked: z.boolean(),
  }),
  z.object({
    action: z.literal('page.select'),
    frameId: FrameIdSchema.optional(),
    target: BrowserRunTargetSchema,
    values: z.array(z.string().max(10_000)).min(1).max(100),
  }),
  z.object({
    action: z.literal('page.drag'),
    frameId: FrameIdSchema.optional(),
    source: BrowserRunTargetSchema,
    target: BrowserRunTargetSchema,
  }),
  z.object({
    action: z.literal('page.focus'),
    frameId: FrameIdSchema.optional(),
    target: BrowserRunTargetSchema,
  }),
  z.object({
    action: z.literal('page.inspect'),
    frameId: FrameIdSchema.optional(),
    target: BrowserRunTargetSchema,
    maxChars: z.number().int().min(1).max(10_000).optional(),
  }),
  z.object({
    action: z.literal('page.hover'),
    frameId: FrameIdSchema.optional(),
    target: BrowserRunTargetSchema,
  }),
  z.object({
    action: z.literal('page.press'),
    key: KeySchema,
    modifiers: z
      .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
      .max(4)
      .optional(),
  }),
  z.object({
    action: z.literal('page.pointer'),
    type: z.enum(['move', 'down', 'up', 'click']),
    x: CoordinateSchema,
    y: CoordinateSchema,
    button: MouseButtonSchema.optional(),
    clickCount: z.number().int().min(1).max(2).optional(),
  }),
  z.object({
    action: z.literal('page.scroll'),
    frameId: FrameIdSchema.optional(),
    target: BrowserRunTargetSchema.optional(),
    direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
    distance: z.number().int().min(1).max(100_000).optional(),
    deltaX: ScrollDeltaSchema.optional(),
    deltaY: ScrollDeltaSchema.optional(),
  }),
  z.object({
    action: z.literal('page.wait'),
    frameId: FrameIdSchema.optional(),
    condition: z.enum(['target', 'time', 'navigation', 'networkIdle', 'popup', 'download']),
    target: BrowserRunTargetSchema.optional(),
    timeMs: z.number().int().min(0).max(30_000).optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
    idleMs: z.number().int().min(100).max(5_000).optional(),
  }),
  z.object({
    action: z.literal('page.dialog.respond'),
    accept: z.boolean(),
    promptText: z.string().max(10_000).optional(),
  }),
]);

type BrowserRunAtomicStepCommand = z.infer<typeof BrowserRunAtomicStepCommandSchema>;

export const BrowserRunCommandStepSchema = z.object({
  kind: z.literal('command'),
  id: z.string().trim().min(1).max(64).optional(),
  command: BrowserRunAtomicStepCommandSchema,
  retry: BrowserRunRetrySchema.optional(),
});

export const BrowserRunWaitStepSchema = z.object({
  kind: z.literal('wait'),
  id: z.string().trim().min(1).max(64).optional(),
  timeMs: z.number().int().min(0).max(10_000),
});

const BrowserRunLeafStepSchema = z.discriminatedUnion('kind', [
  BrowserRunCommandStepSchema,
  BrowserRunWaitStepSchema,
]);

export const BrowserRunForEachStepSchema = z.object({
  kind: z.literal('forEach'),
  id: z.string().trim().min(1).max(64).optional(),
  items: z.array(z.string().max(10_000)).min(1).max(100),
  onError: z.enum(['stop', 'continue']).optional(),
  steps: z.array(BrowserRunLeafStepSchema).min(1).max(20),
});

const BrowserRunStepSchema = z.union([
  BrowserRunCommandStepSchema,
  BrowserRunWaitStepSchema,
  BrowserRunForEachStepSchema,
]);

export const BrowserRunCommandSchema = z
  .object({
    action: z.literal('browser.run'),
    tabId: TabIdSchema.optional(),
    timeoutMs: z.number().int().min(100).max(300_000).optional(),
    steps: z.array(BrowserRunStepSchema).min(1).max(50),
  })
  .superRefine((run, context) => {
    const validateCommand = (
      command: BrowserRunAtomicStepCommand,
      path: Array<string | number>
    ): void => {
      if (
        command.action === 'page.scroll' &&
        command.target === undefined &&
        command.direction === undefined &&
        command.deltaX === undefined &&
        command.deltaY === undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: 'BrowserRun page.scroll requires a direction, target, or delta',
        });
      }
      if (
        command.action === 'page.wait' &&
        command.condition === 'target' &&
        command.target === undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: 'BrowserRun target wait requires a target',
        });
      }
    };

    let atomicCommands = 0;
    run.steps.forEach((step, stepIndex) => {
      if (step.kind === 'command') {
        atomicCommands += 1;
        validateCommand(step.command, ['steps', stepIndex, 'command']);
        if (step.command.action === 'page.type' && typeof step.command.text !== 'string') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', stepIndex, 'command', 'text'],
            message: 'Top-level page.type cannot reference a forEach item',
          });
        }
        return;
      }
      if (step.kind === 'forEach') {
        const childCommands = step.steps.filter(child => child.kind === 'command');
        childCommands.forEach((child, childIndex) =>
          validateCommand(child.command, ['steps', stepIndex, 'steps', childIndex, 'command'])
        );
        atomicCommands += step.items.length * childCommands.length;
      }
    });
    if (atomicCommands > 2_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: 'BrowserRun cannot exceed 2,000 atomic commands',
      });
    }
  });

export type BrowserRunCommand = z.infer<typeof BrowserRunCommandSchema>;
export type BrowserRunCommandStep = z.infer<typeof BrowserRunCommandStepSchema>;
export type BrowserRunWaitStep = z.infer<typeof BrowserRunWaitStepSchema>;
export type BrowserRunForEachStep = z.infer<typeof BrowserRunForEachStepSchema>;
export type BrowserRunTarget = z.infer<typeof BrowserRunTargetSchema>;

export const BrowserRunResultSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(['completed', 'partial', 'failed']),
  summary: z.object({
    commands: z.number().int().nonnegative(),
    iterations: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  failures: z
    .array(
      z.object({
        stepId: z.string().max(64).optional(),
        itemIndex: z.number().int().nonnegative().optional(),
        item: z.string().max(10_000).optional(),
        message: z.string().max(10_000),
      })
    )
    .max(2_000),
});

export type BrowserRunResult = z.infer<typeof BrowserRunResultSchema>;

export type BrowserPageCommand = Extract<BrowserAtomicCommand, { action: `page.${string}` }>;

const BROWSER_SESSION_SCOPED_ACTIONS = new Set<BrowserAtomicCommand['action']>([
  'tabs.list',
  'tabs.get',
  'tabs.update',
  'tabs.move',
  'tabs.duplicate',
  'tabs.discard',
  'tabs.close',
  'tabs.activate',
  'windows.list',
  'windows.update',
  'tabGroups.list',
  'tabGroups.update',
  'zoom.get',
  'zoom.set',
]);

const BrowserSessionScopedAtomicCommandSchema = BrowserAtomicCommandSchema.refine(
  command =>
    command.action.startsWith('page.') || BROWSER_SESSION_SCOPED_ACTIONS.has(command.action),
  {
    message: 'BrowserSession accepts page, owned workspace, zoom, or browser.run commands only',
  }
);

export const BrowserSessionScopedCommandSchema = z.union([
  BrowserSessionScopedAtomicCommandSchema,
  BrowserRunCommandSchema,
]);

export const BrowserSessionCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('browser.session.create'),
    url: WebUrlSchema,
    browserId: BrowserIdSchema.optional(),
  }),
  z.object({ action: z.literal('browser.session.list') }),
  z.object({ action: z.literal('browser.session.get'), sessionId: BrowserSessionIdSchema }),
  z.object({
    action: z.literal('browser.session.open'),
    sessionId: BrowserSessionIdSchema,
    url: WebUrlSchema,
    active: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('browser.session.command'),
    sessionId: BrowserSessionIdSchema,
    command: BrowserSessionScopedCommandSchema,
  }),
  z.object({ action: z.literal('browser.session.release'), sessionId: BrowserSessionIdSchema }),
]);

export type BrowserSessionCommand = z.infer<typeof BrowserSessionCommandSchema>;
export type BrowserSessionScopedCommand = z.infer<typeof BrowserSessionScopedCommandSchema>;

export const BrowserSessionSnapshotSchema = z
  .object({
    sessionId: BrowserSessionIdSchema,
    browserId: BrowserIdSchema,
    windowId: WindowIdSchema,
    groupId: TabGroupIdSchema,
    ownedTabIds: z.array(TabIdSchema).min(1).max(32),
    activeTabId: TabIdSchema,
  })
  .superRefine((session, context) => {
    if (!session.ownedTabIds.includes(session.activeTabId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activeTabId'],
        message: 'BrowserSession active tab must belong to the session',
      });
    }
  });

export type BrowserSessionSnapshot = z.infer<typeof BrowserSessionSnapshotSchema>;

export const BrowserSessionListResultSchema = z.object({
  sessions: z.array(BrowserSessionSnapshotSchema).max(32),
});

export const BrowserSessionCommandResultSchema = z.object({
  sessionId: BrowserSessionIdSchema,
  tabId: TabIdSchema,
  result: z.unknown(),
});

export const BrowserSessionReleaseResultSchema = z.object({
  sessionId: BrowserSessionIdSchema,
  released: z.literal(true),
  closedOwnedTabIds: z.array(TabIdSchema).max(32),
});

export const BrowserTabSchema = z.object({
  id: TabIdSchema,
  windowId: WindowIdSchema,
  groupId: z.number().int().min(-1),
  active: z.boolean(),
  title: z.string().max(100_000),
  url: z.string().max(100_000),
  cdpAttached: z.boolean(),
});

export type BrowserTab = z.infer<typeof BrowserTabSchema>;

export const BrowserTabsResultSchema = z.array(BrowserTabSchema).max(10_000);
export const BrowserWindowOpenResultSchema = z.object({
  windowId: WindowIdSchema,
  tabId: TabIdSchema,
  url: WebUrlSchema,
});
export const BrowserTabOpenResultSchema = z.object({
  id: TabIdSchema,
  windowId: WindowIdSchema,
  url: WebUrlSchema,
});
export const BrowserTabGroupSchema = z.object({
  id: TabGroupIdSchema,
  windowId: WindowIdSchema,
  title: z.string().max(256),
  color: z.enum(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']),
  collapsed: z.boolean(),
});

const SiteRecipeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
const SiteRecipeReviewTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SiteRecipeDomainSchema = z.enum(['x.com', 'twitter.com']);
const SiteRecipePathPrefixSchema = z.string().startsWith('/').max(2048);
const SiteRecipeCommonShape = {
  id: SiteRecipeIdSchema,
  version: z.number().int().min(1).max(1_000_000),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000),
  domains: z.array(SiteRecipeDomainSchema).min(1).max(8),
  pathPrefixes: z.array(SiteRecipePathPrefixSchema).min(1).max(16),
};

export const SiteRecipeMuteWordsDefinitionSchema = z
  .object({
    ...SiteRecipeCommonShape,
    kind: z.literal('x.mute-words'),
    targets: z
      .object({
        add: BrowserSemanticTargetSchema,
        input: BrowserSemanticTargetSchema,
        save: BrowserSemanticTargetSchema,
      })
      .strict(),
    retry: BrowserRunRetrySchema,
    waitAfterItemMs: z.number().int().min(0).max(10_000),
  })
  .strict();

export const SiteRecipeReadGrokDefinitionSchema = z
  .object({
    ...SiteRecipeCommonShape,
    kind: z.literal('x.read-grok-conversation'),
    scope: z.enum(['body', 'main']),
    defaultMaxChars: z.number().int().min(1).max(100_000),
  })
  .strict();

export const SiteRecipeDefinitionSchema = z.discriminatedUnion('kind', [
  SiteRecipeMuteWordsDefinitionSchema,
  SiteRecipeReadGrokDefinitionSchema,
]);

export type SiteRecipeDefinition = z.infer<typeof SiteRecipeDefinitionSchema>;

const SiteRecipeLifecycleShape = {
  source: z.enum(['builtin', 'user']),
  status: z.enum(['draft', 'approved']),
  reviewToken: SiteRecipeReviewTokenSchema,
};

export const SiteRecipeSchema = z
  .discriminatedUnion('kind', [
    SiteRecipeMuteWordsDefinitionSchema.extend(SiteRecipeLifecycleShape),
    SiteRecipeReadGrokDefinitionSchema.extend(SiteRecipeLifecycleShape),
  ])
  .superRefine((recipe, context) => {
    if (recipe.source === 'builtin' && recipe.status !== 'approved') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Built-in SiteRecipes must be approved',
      });
    }
  });

export type SiteRecipe = z.infer<typeof SiteRecipeSchema>;

export const SiteRecipeListResultSchema = z.object({
  recipes: z.array(SiteRecipeSchema).max(102),
});

const SiteRecipeMuteWordsInputSchema = z
  .object({
    kind: z.literal('x.mute-words'),
    words: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(100)
      .refine(words => new Set(words).size === words.length, {
        message: 'Muted words must be unique',
      }),
  })
  .strict();

const SiteRecipeReadGrokInputSchema = z
  .object({
    kind: z.literal('x.read-grok-conversation'),
    maxChars: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

export const SiteRecipeRunInputSchema = z.discriminatedUnion('kind', [
  SiteRecipeMuteWordsInputSchema,
  SiteRecipeReadGrokInputSchema,
]);

export type SiteRecipeRunInput = z.infer<typeof SiteRecipeRunInputSchema>;

export const BrowserRecipeCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('browser.recipe.list') }),
  z.object({ action: z.literal('browser.recipe.get'), recipeId: SiteRecipeIdSchema }),
  z.object({
    action: z.literal('browser.recipe.draft.save'),
    recipe: SiteRecipeDefinitionSchema,
  }),
  z.object({
    action: z.literal('browser.recipe.approve'),
    recipeId: SiteRecipeIdSchema,
    reviewToken: SiteRecipeReviewTokenSchema,
    confirm: z.literal('APPROVE_SITE_RECIPE'),
  }),
  z.object({
    action: z.literal('browser.recipe.run'),
    recipeId: SiteRecipeIdSchema,
    sessionId: BrowserSessionIdSchema,
    input: SiteRecipeRunInputSchema,
  }),
]);

export type BrowserRecipeCommand = z.infer<typeof BrowserRecipeCommandSchema>;

export const BrowserOneShotCommandSchema = z.object({
  action: z.literal('browser.oneShot'),
  url: WebUrlSchema,
  command: BrowserSessionScopedCommandSchema,
  browserId: BrowserIdSchema.optional(),
});

export type BrowserOneShotCommand = z.infer<typeof BrowserOneShotCommandSchema>;

const SiteRecipeResultBaseShape = {
  recipeId: SiteRecipeIdSchema,
  version: z.number().int().positive(),
  status: z.enum(['completed', 'partial', 'failed']),
};

export const SiteRecipeRunResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...SiteRecipeResultBaseShape,
      kind: z.literal('x.mute-words'),
      output: z
        .object({
          added: z.array(z.string().max(100)).max(100),
          skipped: z.array(z.string().max(100)).max(100),
          failed: z
            .array(
              z.object({
                item: z.string().max(100),
                message: z.string().max(10_000),
              })
            )
            .max(100),
        })
        .strict(),
      summary: z
        .object({
          requested: z.number().int().min(1).max(100),
          attempted: z.number().int().min(0).max(100),
          retries: z.number().int().nonnegative(),
          durationMs: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...SiteRecipeResultBaseShape,
      kind: z.literal('x.read-grok-conversation'),
      output: z
        .object({
          url: WebUrlSchema,
          title: z.string().max(1_000),
          text: z.string().max(100_000),
          capturedAt: z.string().datetime(),
          truncated: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);

export type SiteRecipeRunResult = z.infer<typeof SiteRecipeRunResultSchema>;

export const BrowserCommandSchema = z.union([
  BrowserAtomicCommandSchema,
  BrowserRunCommandSchema,
  BrowserSessionCommandSchema,
  BrowserRecipeCommandSchema,
  BrowserOneShotCommandSchema,
]);

export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;

export const BrowserMediaItemSchema = z.object({
  ref: MediaRefSchema,
  kind: z.enum(['image', 'video', 'stream']),
  source: z.enum(['dom', 'network']),
  url: WebUrlSchema,
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255).optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  duration: z.number().nonnegative().finite().optional(),
});

export type BrowserMediaItem = z.infer<typeof BrowserMediaItemSchema>;

export const BrowserMediaResultSchema = z.object({
  tabId: TabIdSchema,
  pageUrl: WebUrlSchema,
  items: z.array(BrowserMediaItemSchema).max(500),
  truncated: z.boolean(),
  skippedBlobMedia: z.number().int().nonnegative(),
});

export type BrowserMediaResult = z.infer<typeof BrowserMediaResultSchema>;

export const BrowserSubtitleDispatchSchema = z.object({
  pageUrl: WebUrlSchema,
  title: z.string().trim().min(1).max(1_000).optional(),
  mediaUrl: WebUrlSchema.refine(
    value => value.length <= 16_384,
    'Media URL is too long'
  ).optional(),
  userAgent: z.string().trim().min(1).max(512).optional(),
  inlineSubtitle: z
    .object({
      language: z.string().trim().min(1).max(64),
      text: z.string().max(200_000),
      truncated: z.boolean(),
    })
    .optional(),
});

export type BrowserSubtitleDispatch = z.infer<typeof BrowserSubtitleDispatchSchema>;

export const BrowserTranscriptSegmentSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
  text: z.string().trim().min(1).max(10_000),
});

export const BrowserSubtitleResultSchema = z.object({
  pageUrl: WebUrlSchema,
  title: z.string().max(1_000).optional(),
  source: z.enum(['subtitle', 'local-asr']),
  language: z.string().trim().min(1).max(64),
  format: z.enum(['vtt', 'srt', 'text']),
  text: z.string().max(200_000),
  segments: z.array(BrowserTranscriptSegmentSchema).max(20_000).optional(),
  truncated: z.boolean(),
});

export type BrowserSubtitleResult = z.infer<typeof BrowserSubtitleResultSchema>;

export const BrowserSubtitleDownloadResultSchema = z.object({
  pageUrl: WebUrlSchema,
  title: z.string().max(1_000).optional(),
  language: z.string().trim().min(1).max(64),
  format: z.enum(['vtt', 'srt']),
  filename: z.string().max(4096),
});

export type BrowserSubtitleDownloadResult = z.infer<typeof BrowserSubtitleDownloadResultSchema>;

export const BrowserDownloadDispatchSchema = z.discriminatedUnion('backend', [
  z.object({
    backend: z.literal('chrome'),
    downloadId: z.number().int().nonnegative(),
  }),
  z.object({
    backend: z.literal('external'),
    url: WebUrlSchema,
    pageUrl: WebUrlSchema,
    mediaKind: z.enum(['video', 'stream']),
  }),
]);

export type BrowserDownloadDispatch = z.infer<typeof BrowserDownloadDispatchSchema>;

export const BrowserDownloadStatusSchema = z.object({
  downloadId: z.string().trim().min(1).max(100),
  backend: z.enum(['chrome', 'local']),
  state: z.enum(['in_progress', 'complete', 'interrupted', 'error']),
  filename: z.string().max(4096).optional(),
  error: z.string().max(1_000).optional(),
});

export type BrowserDownloadStatus = z.infer<typeof BrowserDownloadStatusSchema>;

export const BrowserHostControlCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('host.status') }),
  z.object({ action: z.literal('host.shutdown') }),
  z.object({ action: z.literal('pairing.list') }),
  z.object({ action: z.literal('pairing.approve'), browserId: BrowserIdSchema }),
  z.object({ action: z.literal('pairing.reject'), browserId: BrowserIdSchema }),
]);

export type BrowserHostControlCommand = z.infer<typeof BrowserHostControlCommandSchema>;

export const BrowserControlRequestSchema = z.object({
  protocolVersion: z.literal(EV_PROTOCOL_VERSION),
  requestId: z.string().uuid(),
  token: z.string().min(32).max(512),
  command: z.union([BrowserCommandSchema, BrowserHostControlCommandSchema]),
});

export type BrowserControlRequest = z.infer<typeof BrowserControlRequestSchema>;

export const BrowserControlResponseSchema = z.discriminatedUnion('success', [
  z.object({
    requestId: z.string().uuid(),
    success: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    requestId: z.string().uuid(),
    success: z.literal(false),
    error: z.object({
      code: z.string().trim().min(1).max(100),
      message: z.string().max(10_000),
    }),
  }),
]);

export type BrowserControlResponse = z.infer<typeof BrowserControlResponseSchema>;

export const DesktopToExtensionMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('bridge.hello.ack'),
    protocolVersion: z.literal(EV_PROTOCOL_VERSION),
  }),
  z.object({
    type: z.literal('bridge.pong'),
    timestamp: z.number(),
  }),
  z.object({ type: z.literal('bridge.pair.pending') }),
  z.object({
    type: z.literal('bridge.pair.approved'),
    protocolVersion: z.literal(EV_PROTOCOL_VERSION),
    pairingToken: z.string().min(16).max(512),
  }),
  z.object({
    type: z.literal('browser.command'),
    id: z.string().uuid(),
    command: BrowserAtomicCommandSchema,
  }),
]);

export type DesktopToExtensionMessage = z.infer<typeof DesktopToExtensionMessageSchema>;

export const BridgeConfigSchema = z.object({
  enabled: z.boolean(),
  // Optional bridge WebSocket endpoint override. Lets each browser (Chrome,
  // Edge, ...) point at its own EV Host profile port; defaults to
  // ws://127.0.0.1:43121/browser when absent.
  endpoint: z
    .string()
    .trim()
    .url()
    .refine(value => value.startsWith('ws://127.0.0.1:') || value.startsWith('ws://localhost:'), {
      message: 'bridge endpoint must be a local ws:// URL',
    })
    .optional(),
});

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

const BrowserResponseSchema = z.discriminatedUnion('success', [
  z.object({
    type: z.literal('browser.response'),
    id: z.string().uuid(),
    success: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal('browser.response'),
    id: z.string().uuid(),
    success: z.literal(false),
    error: z.string().max(10_000),
  }),
]);

export const ExtensionToDesktopMessageSchema = z.union([
  z.object({
    type: z.literal('bridge.pair.request'),
    protocolVersion: z.literal(EV_PROTOCOL_VERSION),
    browserId: BrowserIdSchema,
    browserName: z.string().trim().min(1).max(100),
    extensionVersion: z.string().trim().min(1).max(100),
  }),
  z.object({
    type: z.literal('bridge.hello'),
    protocolVersion: z.literal(EV_PROTOCOL_VERSION),
    browserId: BrowserIdSchema,
    browserName: z.string().trim().min(1).max(100),
    extensionVersion: z.string().trim().min(1).max(100),
    pairingToken: z.string().min(16).max(512),
  }),
  z.object({ type: z.literal('bridge.ping'), timestamp: z.number().finite() }),
  BrowserResponseSchema,
]);

export type ExtensionToDesktopMessage = z.infer<typeof ExtensionToDesktopMessageSchema>;
