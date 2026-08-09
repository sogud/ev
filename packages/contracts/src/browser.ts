import { z } from 'zod';

import { EV_PROTOCOL_VERSION } from './protocol';

const TabIdSchema = z.number().int().nonnegative();
const WebUrlSchema = z
  .string()
  .url()
  .max(4096)
  .refine(value => ['http:', 'https:'].includes(new URL(value).protocol), {
    message: 'Only HTTP(S) URLs are supported',
  });

const SelectorSchema = z.string().trim().min(1).max(2048);
const MediaRefSchema = z.string().regex(/^@m[1-9]\d*$/);
const BoundedLimitSchema = z.number().int().min(1).max(1_000);
const KeySchema = z.enum([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
]);

export const BrowserCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('browser.capabilities') }),
  z.object({ action: z.literal('tabs.list') }),
  z.object({
    action: z.literal('tabs.open'),
    url: WebUrlSchema,
    active: z.boolean().optional(),
  }),
  z.object({ action: z.literal('tabs.close'), tabId: TabIdSchema }),
  z.object({ action: z.literal('tabs.activate'), tabId: TabIdSchema }),
  z.object({
    action: z.literal('page.navigate'),
    tabId: TabIdSchema.optional(),
    url: WebUrlSchema,
  }),
  z.object({
    action: z.literal('page.context'),
    tabId: TabIdSchema.optional(),
    maxChars: z.number().int().min(1).max(100_000).optional(),
  }),
  z.object({
    action: z.literal('page.snapshot'),
    tabId: TabIdSchema.optional(),
    mode: z.enum(['full', 'interactive']).optional(),
    maxNodes: BoundedLimitSchema.optional(),
    maxChars: z.number().int().min(1).max(200_000).optional(),
  }),
  z.object({
    action: z.literal('page.click'),
    tabId: TabIdSchema.optional(),
    selector: SelectorSchema,
  }),
  z.object({
    action: z.literal('page.type'),
    tabId: TabIdSchema.optional(),
    selector: SelectorSchema,
    text: z.string().max(100_000),
    clearFirst: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('page.hover'),
    tabId: TabIdSchema.optional(),
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
    action: z.literal('page.scroll'),
    tabId: TabIdSchema.optional(),
    direction: z.enum(['up', 'down', 'top', 'bottom']),
    distance: z.number().int().min(1).max(100_000).optional(),
  }),
  z.object({
    action: z.literal('page.wait'),
    tabId: TabIdSchema.optional(),
    selector: SelectorSchema.optional(),
    timeMs: z.number().int().min(0).max(30_000).optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
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
    selector: SelectorSchema,
    filePaths: z.array(z.string().trim().min(1).max(4096)).min(1).max(10),
  }),
  z.object({ action: z.literal('page.frames'), tabId: TabIdSchema.optional() }),
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
]);

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
    command: BrowserCommandSchema,
  }),
]);

export type DesktopToExtensionMessage = z.infer<typeof DesktopToExtensionMessageSchema>;

export const BridgeConfigSchema = z.object({
  enabled: z.boolean(),
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
    browserId: z.string().uuid(),
    browserName: z.string().trim().min(1).max(100),
    extensionVersion: z.string().trim().min(1).max(100),
  }),
  z.object({
    type: z.literal('bridge.hello'),
    protocolVersion: z.literal(EV_PROTOCOL_VERSION),
    browserId: z.string().uuid(),
    browserName: z.string().trim().min(1).max(100),
    extensionVersion: z.string().trim().min(1).max(100),
    pairingToken: z.string().min(16).max(512),
  }),
  z.object({ type: z.literal('bridge.ping'), timestamp: z.number().finite() }),
  BrowserResponseSchema,
]);

export type ExtensionToDesktopMessage = z.infer<typeof ExtensionToDesktopMessageSchema>;
