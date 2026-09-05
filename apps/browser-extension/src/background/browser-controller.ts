import {
  BrowserDownloadDispatchSchema,
  BrowserDownloadStatusSchema,
  BrowserMediaResultSchema,
  BrowserSubtitleDispatchSchema,
  BrowserWebMcpCallResultSchema,
  BrowserWebMcpListResultSchema,
  type BrowserAtomicCommand,
  type BookmarkBackupNode,
  type BrowserMediaItem,
  type BrowserPageCommand,
} from '@ev/contracts';

import { cdpHighlightDeclaration } from '../content/action-highlight';
import { WEBMCP_DEFAULT_TIMEOUT_MS } from '../webmcp/protocol';
import { highlightBeforeAction, isActionHighlightEnabled } from './action-highlight';
import { callPageWebMcpTool, listPageWebMcpTools } from './webmcp-bridge';

const CDP_VERSION = '1.3';
const MAX_EVENT_RECORDS = 500;
const MAX_EVENT_STRING_CHARS = 10_000;
const MAX_MEDIA_SCAN_ITEMS = 2_000;
const SENSITIVE_EVENT_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'postdata',
  'postdataentries',
  'password',
  'token',
  'accesstoken',
  'associatedcookies',
]);
const DOM_PAGE_ACTIONS = [
  'page.navigate',
  'page.history',
  'page.context',
  'page.snapshot',
  'page.click',
  'page.type',
  'page.setChecked',
  'page.select',
  'page.focus',
  'page.inspect',
  'page.scroll',
  'page.wait',
  'page.screenshot',
  'page.subtitles',
  'page.release',
] as const;
const WEBMCP_ACTIONS = ['page.webmcp.listTools', 'page.webmcp.callTool'] as const;
const CDP_PAGE_ACTIONS = [
  'page.drag',
  'page.hover',
  'page.press',
  'page.pointer',
  'page.dialog.respond',
  'page.upload',
  'page.frames',
  'page.media',
  'page.download',
  'page.logs',
  'page.network',
  'page.emulate',
] as const;
const BROWSER_SHELL_ACTIONS = [
  'windows.list',
  'windows.open',
  'windows.update',
  'windows.close',
  'tabs.list',
  'tabs.get',
  'tabs.open',
  'tabs.update',
  'tabs.move',
  'tabs.duplicate',
  'tabs.discard',
  'tabs.close',
  'tabs.activate',
  'tabGroups.list',
  'tabGroups.add',
  'tabGroups.create',
  'tabGroups.update',
  'tabGroups.ungroup',
  'downloads.status',
  'downloads.list',
  'downloads.pause',
  'downloads.resume',
  'downloads.cancel',
  'downloads.open',
  'downloads.show',
  'downloads.remove',
  'history.search',
  'history.getVisits',
  'history.remove',
  'sessions.recent',
  'sessions.restore',
  'zoom.get',
  'zoom.set',
] as const;
const BOOKMARK_ACTIONS = [
  'bookmarks.list',
  'bookmarks.search',
  'bookmarks.create',
  'bookmarks.update',
  'bookmarks.move',
  'bookmarks.remove',
  'bookmarks.removeTree',
  'bookmarks.export',
  'bookmarks.restore',
] as const;
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

type CdpParams = Record<string, unknown>;
type CdpResult = Record<string, unknown>;

interface AxValue {
  value?: unknown;
}

interface AxNode {
  nodeId?: string;
  parentId?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  description?: AxValue;
  backendDOMNodeId?: number;
}

interface BrowserEventRecord {
  timestamp: number;
  method: string;
  data: CdpParams;
}

interface RawNetworkMedia {
  url: string;
  mimeType?: string;
}

interface DomMediaCandidate {
  kind: 'image' | 'video';
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number;
}

interface DomMediaScan {
  pageUrl: string;
  items: DomMediaCandidate[];
  resourceUrls: string[];
  skippedBlobMedia: number;
}

interface CachedMediaItem {
  rawUrl: string;
  pageUrl: string;
  item: BrowserMediaItem;
}

interface BilibiliInlineSubtitleResult {
  language: string;
  text: string;
  truncated: boolean;
}

interface BilibiliInlineSubtitleResponse {
  subtitle?: BilibiliInlineSubtitleResult;
  error?: string;
}

async function readBilibiliSubtitleInPage(
  pageUrl: string,
  requestedLanguage: string | undefined,
  includeAutomatic: boolean,
  maxChars: number
): Promise<BilibiliInlineSubtitleResponse | null> {
  try {
    const page = new URL(pageUrl);
    const bvid = page.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1];
    if (!bvid || (page.hostname !== 'bilibili.com' && !page.hostname.endsWith('.bilibili.com'))) {
      return null;
    }

    const fetchJson = async (url: string, credentials: RequestCredentials): Promise<unknown> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(url, { credentials, signal: controller.signal });
        if (!response.ok) throw new Error(`Bilibili request failed: ${response.status}`);
        const body = await response.text();
        if (body.length > 5 * 1024 * 1024) throw new Error('Bilibili response is too large');
        return JSON.parse(body) as unknown;
      } finally {
        clearTimeout(timeout);
      }
    };

    const view = (await fetchJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      'include'
    )) as Record<string, unknown>;
    const viewData = view.data as Record<string, unknown> | undefined;
    const requestedPage = Number.parseInt(page.searchParams.get('p') ?? '1', 10);
    const pages = Array.isArray(viewData?.pages) ? viewData.pages : [];
    const selectedPage = pages.find(candidate => {
      if (!candidate || typeof candidate !== 'object') return false;
      return (candidate as Record<string, unknown>).page === requestedPage;
    }) as Record<string, unknown> | undefined;
    const cid = selectedPage?.cid ?? viewData?.cid;
    if (typeof cid !== 'number' || !Number.isFinite(cid)) {
      throw new Error('Bilibili did not return a valid video CID');
    }

    const player = (await fetchJson(
      `https://api.bilibili.com/x/player/wbi/v2?cid=${cid}&bvid=${encodeURIComponent(bvid)}`,
      'include'
    )) as Record<string, unknown>;
    const playerData = player.data as Record<string, unknown> | undefined;
    const subtitle = playerData?.subtitle as Record<string, unknown> | undefined;
    const rawTracks = Array.isArray(subtitle?.subtitles) ? subtitle.subtitles : [];
    const tracks = rawTracks.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const track = item as Record<string, unknown>;
      if (typeof track.lan !== 'string' || typeof track.subtitle_url !== 'string') return [];
      if (!track.lan || !track.subtitle_url) return [];
      const automatic = track.lan.startsWith('ai-') || Number(track.ai_type ?? 0) > 0;
      if (!includeAutomatic && automatic) return [];
      return [{ language: track.lan, url: track.subtitle_url, automatic }];
    });
    if (!tracks.length) {
      throw new Error(
        playerData?.need_login_subtitle === true
          ? 'Bilibili subtitles require the logged-in page session'
          : 'No matching Bilibili subtitles found'
      );
    }

    const languageRoot = requestedLanguage?.toLowerCase().split(/[-_]/)[0];
    const selected =
      tracks.find(track => track.language === requestedLanguage) ??
      tracks.find(track => languageRoot && track.language.toLowerCase().startsWith(languageRoot)) ??
      tracks.find(track => track.language === 'ai-zh') ??
      tracks.find(track => track.language.toLowerCase().startsWith('zh')) ??
      tracks[0];
    const subtitleUrl = new URL(
      selected.url.startsWith('//') ? `https:${selected.url}` : selected.url
    );
    if (
      subtitleUrl.protocol !== 'https:' ||
      (subtitleUrl.hostname !== 'hdslb.com' &&
        !subtitleUrl.hostname.endsWith('.hdslb.com') &&
        subtitleUrl.hostname !== 'bilibili.com' &&
        !subtitleUrl.hostname.endsWith('.bilibili.com'))
    ) {
      throw new Error('Bilibili returned an invalid subtitle URL');
    }

    const subtitleJson = (await fetchJson(subtitleUrl.toString(), 'omit')) as Record<
      string,
      unknown
    >;
    const body = Array.isArray(subtitleJson.body) ? subtitleJson.body.slice(0, 20_000) : [];
    const lines: string[] = [];
    for (const item of body) {
      if (!item || typeof item !== 'object') continue;
      const content = (item as Record<string, unknown>).content;
      if (typeof content !== 'string' || content.length > 10_000) continue;
      const text = content.trim();
      if (text && lines.at(-1) !== text) lines.push(text);
    }
    if (!lines.length) throw new Error('Bilibili returned an empty subtitle');
    const text = lines.join('\n');
    return {
      subtitle: {
        language: selected.language,
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars || body.length >= 20_000,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unable to read Bilibili subtitles' };
  }
}

function isWebUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function assertWebUrl(value: string): void {
  if (isWebUrl(value)) return;
  throw new Error('Only HTTP(S) pages can be controlled');
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('No active browser tab');
  return tab.id;
}

async function resolveTab(tabId?: number): Promise<chrome.tabs.Tab> {
  const id = tabId ?? (await activeTabId());
  const deadline = Date.now() + 5_000;
  while (true) {
    const tab = await chrome.tabs.get(id);
    if (isWebUrl(tab.url)) return tab;

    // Chrome can return a freshly-created tab before navigation assigns its
    // final URL. A valid pending URL means the tab is still on the way there;
    // explicit non-web URLs remain unsupported and fail immediately.
    if (tab.pendingUrl) assertWebUrl(tab.pendingUrl);
    else if (tab.url && tab.url !== 'about:blank') assertWebUrl(tab.url);

    if (Date.now() >= deadline) throw new Error(`Tab ${id} did not reach an HTTP(S) URL`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function stringValue(value: AxValue | undefined): string {
  return typeof value?.value === 'string' ? value.value : '';
}

function boundedPush<T>(map: Map<number, T[]>, tabId: number, value: T): void {
  const records = map.get(tabId) ?? [];
  records.push(value);
  if (records.length > MAX_EVENT_RECORDS) records.splice(0, records.length - MAX_EVENT_RECORDS);
  map.set(tabId, records);
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_EVENT_KEYS.has(key.toLowerCase())) url.searchParams.set(key, '[redacted]');
    }
    return url.toString();
  } catch {
    return value;
  }
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function isStreamMedia(url: string, mimeType?: string): boolean {
  const path = httpUrl(url)?.pathname.toLowerCase() ?? '';
  const mime = mimeType?.toLowerCase() ?? '';
  return (
    path.endsWith('.m3u8') ||
    path.endsWith('.mpd') ||
    mime.includes('mpegurl') ||
    mime.includes('dash+xml')
  );
}

function isNetworkMedia(url: string, mimeType?: string): boolean {
  const mime = mimeType?.toLowerCase() ?? '';
  return isStreamMedia(url, mimeType) || mime.startsWith('audio/') || mime.startsWith('video/');
}

function publicMediaUrl(rawUrl: string): string {
  const url = httpUrl(rawUrl);
  if (!url) throw new Error('Media URL must use HTTP(S)');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function defaultMediaExtension(
  rawUrl: string,
  kind: BrowserMediaItem['kind'],
  mimeType?: string
): string {
  if (kind === 'stream') {
    return httpUrl(rawUrl)?.pathname.toLowerCase().endsWith('.mpd') ? '.mpd' : '.m3u8';
  }
  if (kind === 'video') return mimeType?.includes('webm') ? '.webm' : '.mp4';
  if (mimeType?.includes('png')) return '.png';
  if (mimeType?.includes('webp')) return '.webp';
  return '.jpg';
}

function mediaFilename(rawUrl: string, kind: BrowserMediaItem['kind'], mimeType?: string): string {
  const url = httpUrl(rawUrl);
  const fallbackExtension = defaultMediaExtension(rawUrl, kind, mimeType);
  let filename = url?.pathname.split('/').filter(Boolean).at(-1) ?? `media${fallbackExtension}`;
  try {
    filename = decodeURIComponent(filename);
  } catch {
    // Keep the encoded path segment when it is not valid URI encoding.
  }
  filename = filename
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 180);
  if (!filename) filename = `media${fallbackExtension}`;
  if (!filename.includes('.')) filename += fallbackExtension;
  return filename;
}

function sanitizeEventValue(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_EVENT_KEYS.has(key.toLowerCase())) return '[redacted]';
  if (typeof value === 'string') {
    const normalized = key.toLowerCase() === 'url' ? sanitizeUrl(value) : value;
    return normalized.length > MAX_EVENT_STRING_CHARS
      ? `${normalized.slice(0, MAX_EVENT_STRING_CHARS)}…`
      : normalized;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => sanitizeEventValue(item, key, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
    output[childKey] = sanitizeEventValue(childValue, childKey, depth + 1);
  }
  return output;
}

function flattenFrameTree(frameTree: unknown): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  const visit = (node: unknown, parentId?: string): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const frame = record.frame;
    if (frame && typeof frame === 'object') {
      const value = frame as Record<string, unknown>;
      frames.push({
        id: value.id,
        parentId,
        url: value.url,
        name: value.name,
        securityOrigin: value.securityOrigin,
        mimeType: value.mimeType,
      });
      const id = typeof value.id === 'string' ? value.id : parentId;
      if (Array.isArray(record.childFrames)) {
        for (const child of record.childFrames) visit(child, id);
      }
    }
  };
  visit(frameTree);
  return frames;
}

type PressKey = Extract<BrowserAtomicCommand, { action: 'page.press' }>['key'];
type KeyDefinition = { key: string; code: string; keyCode: number; text?: string };

const NAMED_KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

function keyDefinition(key: PressKey): KeyDefinition {
  const named = NAMED_KEY_DEFINITIONS[key];
  if (named) return named;
  const functionKey = /^F(\d{1,2})$/.exec(key);
  if (functionKey) {
    const index = Number(functionKey[1]);
    return { key, code: key, keyCode: 111 + index };
  }
  const upper = key.toUpperCase();
  return {
    key,
    code: /[A-Z]/.test(upper) ? `Key${upper}` : `Digit${key}`,
    keyCode: upper.charCodeAt(0),
    text: key,
  };
}

function tabResult(tab: chrome.tabs.Tab, cdpAttached = false): Record<string, unknown> {
  if (tab.id === undefined) throw new Error('Chrome tab has no id');
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    muted: tab.mutedInfo?.muted ?? false,
    discarded: tab.discarded,
    groupId: tab.groupId,
    title: tab.title ?? '',
    url: tab.url ?? tab.pendingUrl ?? '',
    cdpAttached,
  };
}

function windowResult(window: chrome.windows.Window): Record<string, unknown> {
  if (window.id === undefined) throw new Error('Chrome window has no id');
  return {
    id: window.id,
    focused: window.focused,
    incognito: window.incognito,
    type: window.type,
    state: window.state,
    left: window.left,
    top: window.top,
    width: window.width,
    height: window.height,
    tabIds: (window.tabs ?? []).flatMap(tab => (tab.id === undefined ? [] : [tab.id])),
  };
}

function tabGroupResult(group: chrome.tabGroups.TabGroup): Record<string, unknown> {
  return {
    id: group.id,
    windowId: group.windowId,
    title: group.title ?? '',
    color: group.color,
    collapsed: group.collapsed,
  };
}

function chromeDownloadId(value: string): number {
  const id = Number(value.slice('chrome:'.length));
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`Invalid Chrome download id: ${value}`);
  return id;
}

async function requireDownloadsPermission(): Promise<void> {
  const allowed = await chrome.permissions.contains({ permissions: ['downloads'] });
  if (!allowed) throw new Error('Downloads permission is required');
}

async function requireDownloadsOpenPermission(): Promise<void> {
  const allowed = await chrome.permissions.contains({
    permissions: ['downloads', 'downloads.open'],
  });
  if (!allowed) throw new Error('Downloads permission is required');
}

function downloadResult(item: chrome.downloads.DownloadItem): Record<string, unknown> {
  return {
    downloadId: `chrome:${item.id}`,
    state: item.state,
    paused: item.paused,
    canResume: item.canResume,
    filename: item.filename,
    url: sanitizeUrl(item.url),
    finalUrl: sanitizeUrl(item.finalUrl),
    mime: item.mime,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    exists: item.exists,
    error: item.error,
    startTime: item.startTime,
    endTime: item.endTime,
  };
}

function sessionResult(session: chrome.sessions.Session): Record<string, unknown> | undefined {
  if (session.tab?.sessionId) {
    const tab = session.tab;
    return {
      type: 'tab',
      sessionId: tab.sessionId,
      tab: {
        ...(tab.id === undefined ? {} : { id: tab.id }),
        windowId: tab.windowId,
        index: tab.index,
        active: tab.active,
        pinned: tab.pinned,
        title: tab.title ?? '',
        url: tab.url ?? '',
      },
    };
  }
  if (session.window?.sessionId) {
    const window = session.window;
    return {
      type: 'window',
      sessionId: window.sessionId,
      window: {
        ...(window.id === undefined ? {} : { id: window.id }),
        focused: window.focused,
        state: window.state,
        tabIds: (window.tabs ?? []).flatMap(tab => (tab.id === undefined ? [] : [tab.id])),
      },
    };
  }
  return undefined;
}

type DomPageOperation =
  | { kind: 'context'; maxChars: number; scope: 'body' | 'main' }
  | { kind: 'mediaHint' }
  | { kind: 'history'; operation: 'back' | 'forward' | 'reload' | 'stop' }
  | { kind: 'snapshot'; maxNodes: number; maxChars: number; mode: 'full' | 'interactive' }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string; clearFirst: boolean }
  | { kind: 'setChecked'; selector: string; checked: boolean }
  | { kind: 'select'; selector: string; values: string[] }
  | { kind: 'focus'; selector: string }
  | { kind: 'inspect'; selector: string; maxChars: number }
  | {
      kind: 'scroll';
      selector?: string;
      direction?: 'up' | 'down' | 'top' | 'bottom';
      distance: number;
      deltaX: number;
      deltaY: number;
    }
  | { kind: 'waitTarget'; selector: string; timeoutMs: number };

async function executeDomPageOperation(operation: DomPageOperation): Promise<unknown> {
  const find = (selector: string): Element => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Element not found: ${selector}`);
    return element;
  };
  const selectorFor = (element: Element): string | undefined => {
    if (element.id) {
      const byId = `#${CSS.escape(element.id)}`;
      if (document.querySelectorAll(byId).length === 1) return byId;
    }
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const parentElement: Element | null = current.parentElement;
      if (!parentElement) return undefined;
      const siblings = [...parentElement.children].filter(
        sibling => sibling.tagName === current?.tagName
      );
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      current = parentElement;
    }
    parts.unshift('html');
    const selector = parts.join(' > ');
    return document.querySelector(selector) === element ? selector : undefined;
  };
  const roleFor = (element: Element): string => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      return 'textbox';
    }
    return tag;
  };
  const nameFor = (element: Element): string => {
    const labelledBy = element.getAttribute('aria-labelledby');
    const labelledText = labelledBy
      ?.split(/\s+/)
      .map(id => document.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (labelledText) return labelledText;
    const ariaLabel = element.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel;
    if (element instanceof HTMLInputElement && element.type !== 'password') {
      const label = [...(element.labels ?? [])]
        .map(item => item.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      if (label) return label;
      if (['button', 'submit', 'reset'].includes(element.type) && element.value) {
        return element.value;
      }
    }
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      const label = [...(element.labels ?? [])]
        .map(item => item.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      if (label) return label;
    }
    return (
      element.getAttribute('alt') ??
      element.getAttribute('title') ??
      element.getAttribute('placeholder') ??
      element.textContent ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
  };

  switch (operation.kind) {
    case 'context': {
      const root = operation.scope === 'main' ? document.querySelector('main') : document.body;
      return {
        url: location.href,
        title: document.title,
        selection: getSelection()?.toString().slice(0, operation.maxChars) || undefined,
        text: (root?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, operation.maxChars),
        capturedAt: new Date().toISOString(),
      };
    }
    case 'mediaHint': {
      const mediaUrl = performance
        .getEntriesByType('resource')
        .map(entry => entry.name)
        .reverse()
        .find(value => {
          try {
            const url = new URL(value);
            const mime = url.searchParams.get('mime') ?? '';
            return (
              url.protocol === 'https:' &&
              (mime.toLowerCase().startsWith('audio/') ||
                /\.(m4a|mp3|opus|ogg|wav)(?:$|\?)/i.test(value))
            );
          } catch {
            return false;
          }
        });
      return { mediaUrl, userAgent: navigator.userAgent };
    }
    case 'history':
      if (operation.operation === 'back') history.back();
      if (operation.operation === 'forward') history.forward();
      if (operation.operation === 'reload') location.reload();
      if (operation.operation === 'stop') window.stop();
      return { operation: operation.operation };
    case 'snapshot': {
      const query =
        operation.mode === 'interactive'
          ? 'a[href],button,input,select,textarea,[role],[tabindex],[contenteditable="true"]'
          : 'a[href],button,input,select,textarea,[role],[tabindex],[contenteditable="true"],h1,h2,h3,h4,h5,h6,img';
      const candidates = [...document.querySelectorAll(query)];
      const nodes: Array<Record<string, unknown>> = [];
      let encodedChars = 0;
      for (const element of candidates) {
        const selector = selectorFor(element);
        if (!selector) continue;
        const ref = `@e${nodes.length + 1}`;
        const value: Record<string, unknown> = {
          ref,
          role: roleFor(element),
          name: nameFor(element).slice(0, 1_024),
          selector,
        };
        const description = element.getAttribute('aria-description')?.trim();
        if (description) value.description = description.slice(0, 1_024);
        const nextChars = JSON.stringify(value).length;
        if (nodes.length >= operation.maxNodes || encodedChars + nextChars > operation.maxChars) {
          break;
        }
        encodedChars += nextChars;
        nodes.push(value);
      }
      return { nodes, truncated: nodes.length < candidates.length };
    }
    case 'click': {
      const element = find(operation.selector);
      element.scrollIntoView({ block: 'center', inline: 'center' });
      if (!(element instanceof HTMLElement)) throw new Error('Target is not clickable');
      element.click();
      const rect = element.getBoundingClientRect();
      return { clicked: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    case 'type': {
      const element = find(operation.selector);
      element.scrollIntoView({ block: 'center', inline: 'center' });
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.focus();
        const prototype =
          element instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        const value = operation.clearFirst ? operation.text : element.value + operation.text;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element instanceof HTMLElement && element.isContentEditable) {
        element.focus();
        element.textContent = operation.clearFirst
          ? operation.text
          : (element.textContent ?? '') + operation.text;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      } else {
        throw new Error('Target is not editable');
      }
      return { typed: true, textLength: operation.text.length };
    }
    case 'setChecked': {
      const element = find(operation.selector);
      const role = element.getAttribute('role');
      const native =
        element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type);
      if (!native && !['checkbox', 'radio', 'switch'].includes(role ?? '')) {
        throw new Error('Target is not checkable');
      }
      const current = native ? element.checked : element.getAttribute('aria-checked') === 'true';
      if (current !== operation.checked) {
        if (!(element instanceof HTMLElement)) throw new Error('Target is not clickable');
        element.click();
      }
      return { checked: operation.checked, changed: current !== operation.checked };
    }
    case 'select': {
      const element = find(operation.selector);
      if (!(element instanceof HTMLSelectElement)) {
        throw new Error('Target is not a native select');
      }
      const requested = new Set(operation.values);
      const available = new Set([...element.options].map(option => option.value));
      const missing = operation.values.filter(value => !available.has(value));
      if (missing.length) throw new Error(`Select values not found: ${missing.join(', ')}`);
      for (const option of element.options) option.selected = requested.has(option.value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { selectedValues: [...element.selectedOptions].map(option => option.value) };
    }
    case 'focus': {
      const element = find(operation.selector);
      if (!(element instanceof HTMLElement)) throw new Error('Target is not focusable');
      element.focus();
      return { focused: true };
    }
    case 'inspect': {
      const element = find(operation.selector);
      const attributes: Record<string, string> = {};
      for (const attribute of [...element.attributes].slice(0, 100)) {
        if (!/(password|secret|token|authorization|cookie|value)/i.test(attribute.name)) {
          attributes[attribute.name] = attribute.value.slice(0, operation.maxChars);
        }
      }
      const password = element instanceof HTMLInputElement && element.type === 'password';
      const rawValue =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? element.value
          : (element.textContent ?? '');
      return {
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute('role') ?? undefined,
        value: password ? '[redacted]' : rawValue.slice(0, operation.maxChars),
        checked: element instanceof HTMLInputElement ? element.checked : undefined,
        selectedValues:
          element instanceof HTMLSelectElement
            ? [...element.selectedOptions].map(option => option.value)
            : undefined,
        disabled:
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLButtonElement
            ? element.disabled
            : undefined,
        editable: element instanceof HTMLElement ? element.isContentEditable : false,
        attributes,
      };
    }
    case 'scroll': {
      if (operation.selector) {
        find(operation.selector).scrollIntoView({ block: 'center', inline: 'center' });
      }
      if (operation.deltaX || operation.deltaY) {
        window.scrollBy({ left: operation.deltaX, top: operation.deltaY, behavior: 'instant' });
      }
      if (operation.direction === 'top' || operation.direction === 'bottom') {
        window.scrollTo({
          top: operation.direction === 'top' ? 0 : document.documentElement.scrollHeight,
          behavior: 'instant',
        });
      } else if (operation.direction === 'up' || operation.direction === 'down') {
        window.scrollBy({
          top: operation.direction === 'down' ? operation.distance : -operation.distance,
          behavior: 'instant',
        });
      }
      return { x: window.scrollX, y: window.scrollY };
    }
    case 'waitTarget': {
      const startedAt = Date.now();
      while (Date.now() - startedAt <= operation.timeoutMs) {
        if (document.querySelector(operation.selector)) {
          return { condition: 'target', matched: true, elapsedMs: Date.now() - startedAt };
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for target: ${operation.selector}`);
    }
    default:
      throw new Error('Unsupported fixed DOM page operation');
  }
}

/**
 * Quiet window after the last advanced (CDP) command before the debugger is
 * released, so Chrome's debugging infobar clears on its own. The next advanced
 * command re-attaches on demand.
 */
const DEBUGGER_IDLE_RELEASE_MS = 30_000;

class CdpBrowserController {
  private readonly debuggerApi = (chrome as unknown as { debugger?: typeof chrome.debugger })
    .debugger;
  private readonly scriptingApi = (chrome as unknown as { scripting?: typeof chrome.scripting })
    .scripting;
  private readonly attachedTabs = new Set<number>();
  private readonly attachingTabs = new Map<number, Promise<void>>();
  private readonly debuggerIdleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly inFlightAdvancedByTab = new Map<number, number>();
  private readonly domRefsByTab = new Map<number, Map<string, string>>();
  private readonly refsByTab = new Map<number, Map<string, number>>();
  private readonly mediaByTab = new Map<number, Map<string, CachedMediaItem>>();
  private readonly logsByTab = new Map<number, BrowserEventRecord[]>();
  private readonly networkByTab = new Map<number, BrowserEventRecord[]>();
  private readonly rawNetworkMediaByTab = new Map<number, RawNetworkMedia[]>();
  private readonly inFlightRequestsByTab = new Map<number, Set<string>>();
  private readonly lastNetworkActivityByTab = new Map<number, number>();

  private readonly handleEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object
  ): void => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const requestId = params ? (params as CdpParams).requestId : undefined;
    if (method === 'Network.requestWillBeSent' && typeof requestId === 'string') {
      const requests = this.inFlightRequestsByTab.get(tabId) ?? new Set<string>();
      requests.add(requestId);
      this.inFlightRequestsByTab.set(tabId, requests);
      this.lastNetworkActivityByTab.set(tabId, Date.now());
    }
    if (
      (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') &&
      typeof requestId === 'string'
    ) {
      this.inFlightRequestsByTab.get(tabId)?.delete(requestId);
      this.lastNetworkActivityByTab.set(tabId, Date.now());
    }
    if (method === 'Network.responseReceived' && params) {
      const response = (params as CdpParams).response as Record<string, unknown> | undefined;
      const url = response?.url;
      const mimeType = response?.mimeType;
      if (
        typeof url === 'string' &&
        (mimeType === undefined || typeof mimeType === 'string') &&
        isNetworkMedia(url, mimeType)
      ) {
        boundedPush(this.rawNetworkMediaByTab, tabId, { url, mimeType });
      }
    }
    const data = sanitizeEventValue(params ?? {}) as CdpParams;
    const record = { timestamp: Date.now(), method, data };
    if (method === 'Log.entryAdded' || method === 'Runtime.consoleAPICalled') {
      boundedPush(this.logsByTab, tabId, record);
    }
    if (method === 'Network.requestWillBeSent' || method === 'Network.responseReceived') {
      boundedPush(this.networkByTab, tabId, record);
    }
  };

  private readonly handleDetach = (source: chrome.debugger.Debuggee): void => {
    if (source.tabId === undefined) return;
    this.clearIdleDebuggerRelease(source.tabId);
    this.inFlightAdvancedByTab.delete(source.tabId);
    this.attachedTabs.delete(source.tabId);
    this.refsByTab.delete(source.tabId);
    this.mediaByTab.delete(source.tabId);
    this.rawNetworkMediaByTab.delete(source.tabId);
    this.inFlightRequestsByTab.delete(source.tabId);
    this.lastNetworkActivityByTab.delete(source.tabId);
  };

  constructor() {
    this.debuggerApi?.onEvent.addListener(this.handleEvent);
    this.debuggerApi?.onDetach.addListener(this.handleDetach);
  }

  dispose(): void {
    for (const timer of this.debuggerIdleTimers.values()) clearTimeout(timer);
    this.debuggerIdleTimers.clear();
    this.debuggerApi?.onEvent.removeListener(this.handleEvent);
    this.debuggerApi?.onDetach.removeListener(this.handleDetach);
  }

  async execute(command: BrowserAtomicCommand): Promise<unknown> {
    switch (command.action) {
      case 'browser.capabilities': {
        let transport = 'unavailable';
        if (this.scriptingApi) transport = 'dom';
        if (this.debuggerApi) transport = 'cdp';
        if (this.debuggerApi && this.scriptingApi) transport = 'hybrid';
        return {
          transport,
          cdp: Boolean(this.debuggerApi),
          dom: Boolean(this.scriptingApi),
          arbitraryEval: false,
          actions: [
            ...new Set([
              ...BROWSER_SHELL_ACTIONS,
              ...BOOKMARK_ACTIONS,
              ...WEBMCP_ACTIONS,
              ...(this.scriptingApi ? DOM_PAGE_ACTIONS : []),
              ...(this.debuggerApi ? [...DOM_PAGE_ACTIONS, ...CDP_PAGE_ACTIONS] : []),
            ]),
          ],
        };
      }
      case 'windows.list': {
        const windows = await chrome.windows.getAll({ populate: true });
        return windows.map(windowResult);
      }
      case 'windows.open': {
        assertWebUrl(command.url);
        const window = await chrome.windows.create({
          url: command.url,
          focused: command.focused ?? false,
        });
        if (window.id === undefined) throw new Error('Chrome did not return the created window');
        const tab = window.tabs?.[0] ?? (await chrome.tabs.query({ windowId: window.id }))[0];
        if (tab?.id === undefined) throw new Error('Chrome did not return the created tab');
        return { windowId: window.id, tabId: tab.id, url: tab.url || command.url };
      }
      case 'windows.update': {
        const changes = {
          ...(command.focused === undefined ? {} : { focused: command.focused }),
          ...(command.state === undefined ? {} : { state: command.state }),
          ...(command.left === undefined ? {} : { left: command.left }),
          ...(command.top === undefined ? {} : { top: command.top }),
          ...(command.width === undefined ? {} : { width: command.width }),
          ...(command.height === undefined ? {} : { height: command.height }),
        };
        return windowResult(await chrome.windows.update(command.windowId, changes));
      }
      case 'windows.close':
        await chrome.windows.remove(command.windowId);
        return { closed: true, windowId: command.windowId };
      case 'tabs.list': {
        const tabs = await chrome.tabs.query({});
        return tabs.flatMap(tab =>
          tab.id === undefined ? [] : [tabResult(tab, this.attachedTabs.has(tab.id))]
        );
      }
      case 'tabs.get':
        return tabResult(
          await chrome.tabs.get(command.tabId),
          this.attachedTabs.has(command.tabId)
        );
      case 'tabs.open': {
        assertWebUrl(command.url);
        const tab = await chrome.tabs.create({
          url: command.url,
          ...(command.windowId === undefined ? {} : { windowId: command.windowId }),
          active: command.active ?? true,
        });
        if (tab.id === undefined) throw new Error('Chrome did not return the created tab');
        return { id: tab.id, windowId: tab.windowId, url: tab.url || command.url };
      }
      case 'tabs.update': {
        if (command.url) assertWebUrl(command.url);
        const changes = {
          ...(command.url === undefined ? {} : { url: command.url }),
          ...(command.active === undefined ? {} : { active: command.active }),
          ...(command.pinned === undefined ? {} : { pinned: command.pinned }),
          ...(command.muted === undefined ? {} : { muted: command.muted }),
        };
        return tabResult(await chrome.tabs.update(command.tabId, changes));
      }
      case 'tabs.move': {
        const moved = await chrome.tabs.move(command.tabId, {
          ...(command.windowId === undefined ? {} : { windowId: command.windowId }),
          index: command.index,
        });
        const tab = Array.isArray(moved) ? moved[0] : moved;
        if (!tab) throw new Error('Chrome did not return the moved tab');
        return tabResult(tab);
      }
      case 'tabs.duplicate': {
        const tab = await chrome.tabs.duplicate(command.tabId);
        if (!tab) throw new Error('Chrome did not return the duplicated tab');
        return tabResult(tab);
      }
      case 'tabs.discard': {
        const tab = await chrome.tabs.discard(command.tabId);
        if (!tab) throw new Error('Chrome did not return the discarded tab');
        return tabResult(tab);
      }
      case 'tabs.close':
        await this.release(command.tabId);
        await chrome.tabs.remove(command.tabId);
        return { closed: true, tabId: command.tabId };
      case 'tabs.activate': {
        const tab = await chrome.tabs.update(command.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { activated: true, tabId: command.tabId };
      }
      case 'tabGroups.list': {
        const groups = await chrome.tabGroups.query(
          command.windowId === undefined ? {} : { windowId: command.windowId }
        );
        return groups.map(tabGroupResult);
      }
      case 'tabGroups.add': {
        const groupId = await chrome.tabs.group({
          groupId: command.groupId,
          tabIds: command.tabIds,
        });
        return tabGroupResult(await chrome.tabGroups.get(groupId));
      }
      case 'tabGroups.create': {
        const groupId = await chrome.tabs.group({
          tabIds: command.tabIds,
          ...(command.windowId === undefined
            ? {}
            : { createProperties: { windowId: command.windowId } }),
        });
        const group = await chrome.tabGroups.update(groupId, {
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.color === undefined ? {} : { color: command.color }),
          ...(command.collapsed === undefined ? {} : { collapsed: command.collapsed }),
        });
        return tabGroupResult(group);
      }
      case 'tabGroups.update':
        return tabGroupResult(
          await chrome.tabGroups.update(command.groupId, {
            ...(command.title === undefined ? {} : { title: command.title }),
            ...(command.color === undefined ? {} : { color: command.color }),
            ...(command.collapsed === undefined ? {} : { collapsed: command.collapsed }),
          })
        );
      case 'tabGroups.ungroup':
        await chrome.tabs.ungroup(command.tabIds);
        return { ungroupedTabIds: command.tabIds };
      case 'zoom.get': {
        const tabId = command.tabId ?? (await activeTabId());
        return { tabId, factor: await chrome.tabs.getZoom(tabId) };
      }
      case 'zoom.set': {
        const tabId = command.tabId ?? (await activeTabId());
        await chrome.tabs.setZoom(tabId, command.factor);
        return { tabId, factor: command.factor };
      }
      case 'page.release': {
        const tabId = command.tabId ?? (await activeTabId());
        return { tabId, released: await this.release(tabId) };
      }
      case 'downloads.status':
        return this.downloadStatus(command.downloadId);
      case 'downloads.list': {
        await requireDownloadsPermission();
        const items = await chrome.downloads.search({
          ...(command.query ? { query: [command.query] } : {}),
          ...(command.state ? { state: command.state } : {}),
          limit: command.limit ?? 100,
        });
        return items.slice(0, command.limit ?? 100).map(downloadResult);
      }
      case 'downloads.pause':
        await requireDownloadsPermission();
        await chrome.downloads.pause(chromeDownloadId(command.downloadId));
        return { downloadId: command.downloadId, paused: true };
      case 'downloads.resume':
        await requireDownloadsPermission();
        await chrome.downloads.resume(chromeDownloadId(command.downloadId));
        return { downloadId: command.downloadId, resumed: true };
      case 'downloads.cancel':
        await requireDownloadsPermission();
        await chrome.downloads.cancel(chromeDownloadId(command.downloadId));
        return { downloadId: command.downloadId, cancelled: true };
      case 'downloads.open':
        await requireDownloadsOpenPermission();
        chrome.downloads.open(chromeDownloadId(command.downloadId));
        return { downloadId: command.downloadId, opened: true };
      case 'downloads.show':
        await requireDownloadsPermission();
        chrome.downloads.show(chromeDownloadId(command.downloadId));
        return { downloadId: command.downloadId, shown: true };
      case 'downloads.remove': {
        await requireDownloadsPermission();
        const id = chromeDownloadId(command.downloadId);
        if (command.mode === 'file' || command.mode === 'both')
          await chrome.downloads.removeFile(id);
        if (command.mode === 'record' || command.mode === 'both')
          await chrome.downloads.erase({ id });
        return { downloadId: command.downloadId, removed: command.mode };
      }
      case 'history.search':
        return chrome.history.search({
          text: command.text ?? '',
          ...(command.startTime === undefined ? {} : { startTime: command.startTime }),
          ...(command.endTime === undefined ? {} : { endTime: command.endTime }),
          maxResults: command.maxResults ?? 100,
        });
      case 'history.getVisits':
        return chrome.history.getVisits({ url: command.url });
      case 'history.remove':
        if (command.target.type === 'url') {
          await chrome.history.deleteUrl({ url: command.target.url });
        } else if (command.target.type === 'range') {
          await chrome.history.deleteRange({
            startTime: command.target.startTime,
            endTime: command.target.endTime,
          });
        } else {
          await chrome.history.deleteAll();
        }
        return { removed: command.target.type };
      case 'sessions.recent': {
        const sessions = await chrome.sessions.getRecentlyClosed({
          maxResults: command.maxResults ?? 10,
        });
        return sessions
          .map(sessionResult)
          .filter((session): session is Record<string, unknown> => session !== undefined);
      }
      case 'sessions.restore': {
        const restored = await chrome.sessions.restore(command.sessionId);
        const result = sessionResult(restored);
        if (!result) throw new Error('Chrome did not return a restored session');
        return result;
      }
      case 'bookmarks.list':
        return this.bookmarksList(command.maxNodes ?? 2_000);
      case 'bookmarks.search':
        return this.bookmarksList(command.maxNodes ?? 2_000, command.query);
      case 'bookmarks.create': {
        const node = await chrome.bookmarks.create({
          parentId: command.parentId,
          title: command.title,
          url: command.url,
        });
        return { id: node.id, title: node.title, ...(node.url ? { url: node.url } : {}) };
      }
      case 'bookmarks.update': {
        const node = await chrome.bookmarks.update(command.id, {
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.url === undefined ? {} : { url: command.url }),
        });
        return { id: node.id, title: node.title };
      }
      case 'bookmarks.move': {
        const node = await chrome.bookmarks.move(command.id, {
          parentId: command.parentId,
          index: command.index,
        });
        return { id: node.id, parentId: node.parentId };
      }
      case 'bookmarks.remove':
        await chrome.bookmarks.remove(command.id);
        return { removed: command.id };
      case 'bookmarks.removeTree':
        await chrome.bookmarks.removeTree(command.id);
        return { removedTree: command.id };
      case 'bookmarks.export':
        return this.bookmarksExport();
      case 'bookmarks.restore':
        return this.bookmarksRestore(command.tree, command.parentId, command.title);
      default:
        if (command.action.startsWith('page.')) {
          return this.executePageCommand(command as BrowserPageCommand);
        }
        throw new Error(`Unsupported browser action: ${command.action}`);
    }
  }

  private async bookmarksList(
    maxNodes: number,
    query?: string
  ): Promise<{ nodes: unknown[]; truncated: boolean }> {
    const [root] = await chrome.bookmarks.getTree();
    const needle = query?.toLowerCase();
    const nodes: Array<Record<string, unknown>> = [];
    const collectionLimit = maxNodes + 1;
    const walk = (node: chrome.bookmarks.BookmarkTreeNode, path: string[]): void => {
      const selfPath = node.title ? [...path, node.title] : path;
      if (node.id && node.title) {
        const matches =
          !needle ||
          node.title.toLowerCase().includes(needle) ||
          (node.url ?? '').toLowerCase().includes(needle);
        if (matches) {
          nodes.push({
            id: node.id,
            title: node.title,
            ...(node.url ? { url: node.url } : {}),
            ...(node.parentId ? { parentId: node.parentId } : {}),
            path: selfPath.slice(0, -1).join(' / '),
          });
        }
      }
      if (nodes.length >= collectionLimit) return;
      for (const child of node.children ?? []) {
        walk(child, selfPath);
        if (nodes.length >= collectionLimit) return;
      }
    };
    walk(root, []);
    const truncated = nodes.length > maxNodes;
    return { nodes: truncated ? nodes.slice(0, maxNodes) : nodes, truncated };
  }

  private async bookmarksExport(): Promise<{ exportedAt: string; tree: BookmarkBackupNode[] }> {
    const [root] = await chrome.bookmarks.getTree();
    const strip = (node: chrome.bookmarks.BookmarkTreeNode): BookmarkBackupNode => ({
      title: node.title,
      ...(node.url ? { url: node.url } : {}),
      ...(node.children?.length ? { children: node.children.map(strip) } : {}),
    });
    return {
      exportedAt: new Date().toISOString(),
      tree: (root.children ?? []).map(strip),
    };
  }

  private async bookmarksRestore(
    tree: BookmarkBackupNode[],
    parentId?: string,
    title?: string
  ): Promise<{ restored: boolean; folderId: string; topLevels: number }> {
    const folder = await chrome.bookmarks.create({
      parentId,
      title: title ?? `EV restore ${new Date().toISOString()}`,
    });
    await this.createBookmarkChildren(folder.id, tree);
    return { restored: true, folderId: folder.id, topLevels: tree.length };
  }

  private async createBookmarkChildren(
    parentId: string,
    nodes: BookmarkBackupNode[]
  ): Promise<void> {
    for (const node of nodes) {
      const created = await chrome.bookmarks.create({
        parentId,
        title: node.title,
        url: node.url,
      });
      if (node.children?.length) await this.createBookmarkChildren(created.id, node.children);
    }
  }

  private canExecuteWithoutDebugger(command: BrowserPageCommand): boolean {
    if (command.action === 'page.navigate') return command.frameId === undefined;
    if (command.action === 'page.release') return true;
    if (command.action === 'page.screenshot') return !command.fullPage;
    if (!this.scriptingApi) return false;
    switch (command.action) {
      case 'page.history':
        return true;
      case 'page.context':
      case 'page.snapshot':
      case 'page.type':
      case 'page.setChecked':
      case 'page.select':
      case 'page.focus':
      case 'page.inspect':
      case 'page.scroll':
        return command.frameId === undefined;
      case 'page.click':
        return (
          command.frameId === undefined &&
          (command.button === undefined || command.button === 'left') &&
          (command.clickCount === undefined || command.clickCount === 1) &&
          command.waitFor === undefined
        );
      case 'page.wait': {
        const condition = command.condition ?? (command.selector ? 'target' : 'time');
        return command.frameId === undefined && (condition === 'target' || condition === 'time');
      }
      default:
        return false;
    }
  }

  private async runDomOperation(tabId: number, operation: DomPageOperation): Promise<unknown> {
    if (!this.scriptingApi) throw new Error('Content-script page control is unavailable');
    const results = await this.scriptingApi.executeScript({
      target: { tabId },
      func: executeDomPageOperation,
      args: [operation],
    });
    const result = results[0];
    if (!result) throw new Error('Content-script page control returned no result');
    return result.result;
  }

  private domSelector(tabId: number, selector: string): string {
    if (!selector.startsWith('@e')) return selector;
    const resolved = this.domRefsByTab.get(tabId)?.get(selector);
    if (!resolved) throw new Error(`Snapshot ref is missing or stale: ${selector}`);
    return resolved;
  }

  private async executeWithoutDebugger(
    tabId: number,
    command: BrowserPageCommand
  ): Promise<unknown> {
    if (command.action === 'page.navigate') {
      await chrome.tabs.update(tabId, { url: command.url });
      this.refsByTab.delete(tabId);
      this.domRefsByTab.delete(tabId);
      return { tabId, url: command.url };
    }
    if (command.action === 'page.release') {
      this.domRefsByTab.delete(tabId);
      return { tabId, released: await this.release(tabId) };
    }
    if (command.action === 'page.screenshot') {
      const tab = await chrome.tabs.get(tabId);
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: command.format ?? 'png',
          ...(command.format === 'jpeg' ? { quality: command.quality ?? 90 } : {}),
        });
        const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
        return { tabId, format: command.format ?? 'png', data, fullPage: false };
      } catch {
        // captureVisibleTab requires <all_urls>/activeTab, which EV does not
        // request; fall back to the CDP path for EV-owned tabs.
        await this.ensureAttached(tabId);
        return this.screenshot(tabId, command.format ?? 'png', command.quality ?? 90, false);
      }
    }
    if (command.action === 'page.history') {
      this.refsByTab.delete(tabId);
      this.domRefsByTab.delete(tabId);
      return {
        tabId,
        ...((await this.runDomOperation(tabId, {
          kind: 'history',
          operation: command.operation,
        })) as Record<string, unknown>),
      };
    }
    if (command.action === 'page.context') {
      return this.runDomOperation(tabId, {
        kind: 'context',
        maxChars: command.maxChars ?? 20_000,
        scope: command.scope ?? 'body',
      });
    }
    if (command.action === 'page.snapshot') {
      const snapshot = (await this.runDomOperation(tabId, {
        kind: 'snapshot',
        mode: command.mode ?? 'full',
        maxNodes: command.maxNodes ?? 500,
        maxChars: command.maxChars ?? 100_000,
      })) as { nodes?: Array<Record<string, unknown>>; truncated?: boolean };
      const refs = new Map<string, string>();
      const nodes = (snapshot.nodes ?? []).flatMap(node => {
        const ref = node.ref;
        const selector = node.selector;
        if (typeof ref !== 'string' || typeof selector !== 'string') return [];
        refs.set(ref, selector);
        const { selector: _selector, ...visible } = node;
        return [visible];
      });
      this.domRefsByTab.set(tabId, refs);
      this.refsByTab.delete(tabId);
      return {
        tabId,
        mode: command.mode ?? 'full',
        nodes,
        truncated: snapshot.truncated ?? false,
      };
    }

    const selector =
      'selector' in command && typeof command.selector === 'string'
        ? this.domSelector(tabId, command.selector)
        : undefined;
    if (command.action === 'page.click' && selector) {
      await highlightBeforeAction(tabId, selector, 'click');
      return {
        tabId,
        selector: command.selector,
        ...((await this.runDomOperation(tabId, { kind: 'click', selector })) as object),
      };
    }
    if (command.action === 'page.type' && selector) {
      await highlightBeforeAction(tabId, selector, 'type');
      return {
        tabId,
        selector: command.selector,
        ...((await this.runDomOperation(tabId, {
          kind: 'type',
          selector,
          text: command.text,
          clearFirst: command.clearFirst ?? true,
        })) as object),
      };
    }
    if (command.action === 'page.setChecked' && selector) {
      await highlightBeforeAction(tabId, selector, 'check');
      return {
        tabId,
        selector: command.selector,
        ...((await this.runDomOperation(tabId, {
          kind: 'setChecked',
          selector,
          checked: command.checked,
        })) as object),
      };
    }
    if (command.action === 'page.select' && selector) {
      await highlightBeforeAction(tabId, selector, 'select');
      return {
        tabId,
        selector: command.selector,
        ...((await this.runDomOperation(tabId, {
          kind: 'select',
          selector,
          values: command.values,
        })) as object),
      };
    }
    if (command.action === 'page.focus' && selector) {
      await highlightBeforeAction(tabId, selector, 'focus');
      return {
        tabId,
        selector: command.selector,
        ...((await this.runDomOperation(tabId, { kind: 'focus', selector })) as object),
      };
    }
    if (command.action === 'page.inspect' && selector) {
      return {
        tabId,
        selector: command.selector,
        ...((await this.runDomOperation(tabId, {
          kind: 'inspect',
          selector,
          maxChars: command.maxChars ?? 2_000,
        })) as object),
      };
    }
    if (command.action === 'page.scroll') {
      const resolvedSelector = command.selector
        ? this.domSelector(tabId, command.selector)
        : undefined;
      if (resolvedSelector) await highlightBeforeAction(tabId, resolvedSelector, 'scroll');
      return {
        tabId,
        ...((await this.runDomOperation(tabId, {
          kind: 'scroll',
          selector: resolvedSelector,
          direction: command.direction,
          distance: command.distance ?? 600,
          deltaX: command.deltaX ?? 0,
          deltaY: command.deltaY ?? 0,
        })) as object),
      };
    }
    if (command.action === 'page.wait') {
      const condition = command.condition ?? (command.selector ? 'target' : 'time');
      if (condition === 'time') {
        const startedAt = Date.now();
        await new Promise(resolve => setTimeout(resolve, command.timeMs ?? 0));
        return { tabId, condition, elapsedMs: Date.now() - startedAt };
      }
      if (!command.selector) throw new Error('Target wait requires a selector');
      return {
        tabId,
        ...((await this.runDomOperation(tabId, {
          kind: 'waitTarget',
          selector: this.domSelector(tabId, command.selector),
          timeoutMs: command.timeoutMs ?? 10_000,
        })) as object),
      };
    }
    throw new Error(`Content-script page action is unavailable: ${command.action}`);
  }

  private async executePageCommand(command: BrowserPageCommand): Promise<unknown> {
    const tabId = command.tabId ?? (await activeTabId());
    const tab = await resolveTab(tabId);
    if (command.action === 'page.subtitles') {
      let inlineSubtitle: BilibiliInlineSubtitleResult | undefined;
      const pageUrl = new URL(tab.url!);
      if (
        command.operation === 'read' &&
        (pageUrl.hostname === 'bilibili.com' || pageUrl.hostname.endsWith('.bilibili.com'))
      ) {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          func: readBilibiliSubtitleInPage,
          args: [tab.url!, command.language, command.includeAutomatic, command.maxChars],
        });
        const response = injection?.result as BilibiliInlineSubtitleResponse | null | undefined;
        if (response?.error) throw new Error(response.error);
        inlineSubtitle = response?.subtitle;
      }

      let mediaHint: { mediaUrl?: string; userAgent?: string } = {};
      if (!inlineSubtitle && command.fallback === 'local-asr') {
        mediaHint = await this.withAdvancedLease(tabId, async () => {
          await this.ensureAttached(tabId);
          await new Promise(resolve => setTimeout(resolve, 1_500));
          const domHint = (await this.runDomOperation(tabId, { kind: 'mediaHint' })) as {
            mediaUrl?: string;
            userAgent?: string;
          };
          const observedAudio = [...(this.rawNetworkMediaByTab.get(tabId) ?? [])]
            .reverse()
            .find(item => item.mimeType?.toLowerCase().startsWith('audio/'));
          return { ...domHint, mediaUrl: observedAudio?.url ?? domHint.mediaUrl };
        });
      }
      return BrowserSubtitleDispatchSchema.parse({
        pageUrl: tab.url,
        title: tab.title,
        ...mediaHint,
        ...(inlineSubtitle ? { inlineSubtitle } : {}),
      });
    }
    if (command.action === 'page.webmcp.listTools') return this.webMcpListTools(tabId);
    if (command.action === 'page.webmcp.callTool') return this.webMcpCallTool(tabId, command);
    if (this.canExecuteWithoutDebugger(command)) {
      return this.executeWithoutDebugger(tabId, command);
    }
    return this.withAdvancedLease(tabId, () => this.executeAttached(tabId, command));
  }

  private async webMcpListTools(tabId: number): Promise<unknown> {
    const tools = await listPageWebMcpTools(tabId);
    return BrowserWebMcpListResultSchema.parse({ tabId, tools });
  }

  private async webMcpCallTool(
    tabId: number,
    command: Extract<BrowserPageCommand, { action: 'page.webmcp.callTool' }>
  ): Promise<unknown> {
    const outcome = await callPageWebMcpTool(
      tabId,
      command.name,
      command.args ?? {},
      command.timeoutMs ?? WEBMCP_DEFAULT_TIMEOUT_MS
    );
    return BrowserWebMcpCallResultSchema.parse({ tabId, name: command.name, ...outcome });
  }

  private async executeAttached(tabId: number, command: BrowserPageCommand): Promise<unknown> {
    await this.ensureAttached(tabId);

    switch (command.action) {
      case 'page.navigate': {
        const response = await this.send(tabId, 'Page.navigate', {
          url: command.url,
          ...(command.frameId ? { frameId: command.frameId } : {}),
        });
        return { tabId, url: command.url, frameId: response.frameId };
      }
      case 'page.history':
        return this.navigateHistory(tabId, command.operation);
      case 'page.context': {
        const maxChars = command.maxChars ?? 20_000;
        const scope = command.scope === 'main' ? `document.querySelector('main')` : 'document.body';
        return this.evaluate<Record<string, unknown>>(
          tabId,
          `(() => { const root = ${scope}; return {url: location.href, title: document.title, selection: getSelection()?.toString().slice(0, ${maxChars}) || undefined, text: (root?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, ${maxChars}), capturedAt: new Date().toISOString()}; })()`,
          command.frameId
        );
      }
      case 'page.snapshot':
        return this.snapshot(
          tabId,
          command.mode ?? 'full',
          command.maxNodes,
          command.maxChars,
          command.frameId
        );
      case 'page.click': {
        const backendNodeId = await this.resolveAndHighlight(
          tabId,
          command.selector,
          command.frameId,
          'click'
        );
        await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
        const point = await this.nodeCenter(tabId, backendNodeId);
        if (command.waitFor === 'download') await requireDownloadsPermission();
        let eventWait: Promise<unknown> | undefined;
        if (command.waitFor === 'download') {
          eventWait = this.waitForDownload(tabId, command.timeoutMs ?? 10_000);
        } else if (command.waitFor && command.waitFor !== 'networkIdle') {
          eventWait = this.waitForCondition(
            tabId,
            command.waitFor,
            undefined,
            undefined,
            command.timeoutMs
          );
        }
        let waited: unknown;
        try {
          await this.dispatchClick(tabId, point, command.button ?? 'left', command.clickCount ?? 1);
          if (eventWait) waited = await eventWait;
        } catch (error) {
          void eventWait?.catch(() => undefined);
          throw error;
        }
        if (command.waitFor === 'networkIdle') {
          waited = await this.waitForCondition(
            tabId,
            'networkIdle',
            undefined,
            undefined,
            command.timeoutMs
          );
        }
        return {
          tabId,
          clicked: true,
          selector: command.selector,
          ...point,
          ...(waited ? { waited } : {}),
        };
      }
      case 'page.type': {
        const backendNodeId = await this.resolveAndHighlight(
          tabId,
          command.selector,
          command.frameId,
          'type'
        );
        await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
        await this.send(tabId, 'DOM.focus', { backendNodeId });
        if (command.clearFirst ?? true) await this.clearEditable(tabId, backendNodeId);
        await this.send(tabId, 'Input.insertText', { text: command.text });
        return { tabId, typed: true, selector: command.selector, textLength: command.text.length };
      }
      case 'page.setChecked': {
        const backendNodeId = await this.resolveAndHighlight(
          tabId,
          command.selector,
          command.frameId,
          'check'
        );
        const state = await this.callFunctionOn<{ checkable: boolean; checked: boolean }>(
          tabId,
          backendNodeId,
          `function evReadCheckState() {
            const role = this.getAttribute?.('role');
            const checkable = this instanceof HTMLInputElement && ['checkbox', 'radio'].includes(this.type) || ['checkbox', 'radio', 'switch'].includes(role);
            return { checkable, checked: Boolean(this.checked ?? this.getAttribute?.('aria-checked') === 'true') };
          }`
        );
        if (!state.checkable) throw new Error('Target is not checkable');
        if (state.checked !== command.checked) await this.clickNode(tabId, backendNodeId);
        return {
          tabId,
          selector: command.selector,
          checked: command.checked,
          changed: state.checked !== command.checked,
        };
      }
      case 'page.select': {
        const backendNodeId = await this.resolveAndHighlight(
          tabId,
          command.selector,
          command.frameId,
          'select'
        );
        const result = await this.callFunctionOn<{ selectedValues: string[] }>(
          tabId,
          backendNodeId,
          `function evSelectOptions(values) {
            if (!(this instanceof HTMLSelectElement)) throw new Error('Target is not a native select');
            const requested = new Set(values);
            const available = new Set(Array.from(this.options, option => option.value));
            const missing = values.filter(value => !available.has(value));
            if (missing.length) throw new Error('Select values not found: ' + missing.join(', '));
            for (const option of this.options) option.selected = requested.has(option.value);
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return { selectedValues: Array.from(this.selectedOptions, option => option.value) };
          }`,
          [command.values]
        );
        return { tabId, selector: command.selector, ...result };
      }
      case 'page.drag': {
        const sourceNodeId = await this.resolveAndHighlight(
          tabId,
          command.sourceSelector,
          command.frameId,
          'drag'
        );
        const targetNodeId = await this.resolveAndHighlight(
          tabId,
          command.targetSelector,
          command.frameId,
          'drag'
        );
        const from = await this.nodeCenter(tabId, sourceNodeId);
        const to = await this.nodeCenter(tabId, targetNodeId);
        await this.send(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...from,
          button: 'left',
        });
        await this.send(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...from,
          button: 'left',
          clickCount: 1,
        });
        await this.send(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...to,
          button: 'left',
          buttons: 1,
        });
        await this.send(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...to,
          button: 'left',
          clickCount: 1,
        });
        return {
          tabId,
          dragged: true,
          sourceSelector: command.sourceSelector,
          targetSelector: command.targetSelector,
        };
      }
      case 'page.focus': {
        const backendNodeId = await this.resolveAndHighlight(
          tabId,
          command.selector,
          command.frameId,
          'focus'
        );
        await this.send(tabId, 'DOM.focus', { backendNodeId });
        return { tabId, focused: true, selector: command.selector };
      }
      case 'page.inspect': {
        const backendNodeId = await this.resolveBackendNode(
          tabId,
          command.selector,
          command.frameId
        );
        const maxChars = command.maxChars ?? 2_000;
        const result = await this.callFunctionOn<Record<string, unknown>>(
          tabId,
          backendNodeId,
          `function evInspectElement(maxChars) {
            const truncate = value => typeof value === 'string' ? value.slice(0, maxChars) : value;
            const attributes = {};
            for (const attribute of Array.from(this.attributes ?? []).slice(0, 100)) {
              if (!/(password|secret|token|authorization|cookie|value)/i.test(attribute.name)) attributes[attribute.name] = truncate(attribute.value);
            }
            const password = this instanceof HTMLInputElement && this.type === 'password';
            return {
              tagName: String(this.tagName ?? '').toLowerCase(),
              role: this.getAttribute?.('role') ?? undefined,
              value: password ? '[redacted]' : truncate(this.value ?? this.textContent ?? ''),
              checked: typeof this.checked === 'boolean' ? this.checked : undefined,
              selectedValues: this instanceof HTMLSelectElement ? Array.from(this.selectedOptions, option => option.value) : undefined,
              disabled: typeof this.disabled === 'boolean' ? this.disabled : undefined,
              editable: Boolean(this.isContentEditable),
              attributes,
            };
          }`,
          [maxChars]
        );
        return { tabId, selector: command.selector, ...result };
      }
      case 'page.hover': {
        const backendNodeId = await this.resolveAndHighlight(
          tabId,
          command.selector,
          command.frameId,
          'hover'
        );
        await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
        const { x, y } = await this.nodeCenter(tabId, backendNodeId);
        await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        return { tabId, hovered: true, selector: command.selector, x, y };
      }
      case 'page.press': {
        const definition = keyDefinition(command.key);
        const modifierMap = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
        const modifiers = (command.modifiers ?? []).reduce(
          (value, modifier) => value | modifierMap[modifier],
          0
        );
        const hasCommandModifier =
          (modifiers & (modifierMap.Alt | modifierMap.Control | modifierMap.Meta)) !== 0;
        const base = {
          key: definition.key,
          code: definition.code,
          windowsVirtualKeyCode: definition.keyCode,
          nativeVirtualKeyCode: definition.keyCode,
          modifiers,
          ...(!hasCommandModifier && definition.text ? { text: definition.text } : {}),
        };
        await this.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base });
        await this.send(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...base,
          text: undefined,
        });
        return { tabId, pressed: true, key: command.key, modifiers: command.modifiers ?? [] };
      }
      case 'page.pointer': {
        const button = command.button ?? 'left';
        const clickCount = command.clickCount ?? 1;
        if (command.type === 'click') {
          await this.dispatchClick(tabId, { x: command.x, y: command.y }, button, clickCount);
        } else {
          let type = 'mouseMoved';
          if (command.type === 'down') type = 'mousePressed';
          if (command.type === 'up') type = 'mouseReleased';
          await this.send(tabId, 'Input.dispatchMouseEvent', {
            type,
            x: command.x,
            y: command.y,
            button,
            clickCount,
          });
        }
        return { tabId, ...command };
      }
      case 'page.scroll': {
        let x = 0;
        let y = 0;
        if (command.selector) {
          const backendNodeId = await this.resolveAndHighlight(
            tabId,
            command.selector,
            command.frameId,
            'scroll'
          );
          await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
          ({ x, y } = await this.nodeCenter(tabId, backendNodeId));
        }
        if (command.deltaX !== undefined || command.deltaY !== undefined) {
          await this.send(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x,
            y,
            deltaX: command.deltaX ?? 0,
            deltaY: command.deltaY ?? 0,
          });
        }
        if (command.direction === 'top' || command.direction === 'bottom') {
          const top = command.direction === 'top' ? 0 : 'document.documentElement.scrollHeight';
          await this.evaluate(
            tabId,
            `window.scrollTo({top: ${top}, behavior: 'instant'})`,
            command.frameId
          );
        } else if (command.direction === 'up' || command.direction === 'down') {
          const distance = command.distance ?? 600;
          await this.send(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x,
            y,
            deltaX: 0,
            deltaY: command.direction === 'down' ? distance : -distance,
          });
        }
        const position = await this.evaluate<{ x: number; y: number }>(
          tabId,
          `({x: window.scrollX, y: window.scrollY})`,
          command.frameId
        );
        return { tabId, ...position };
      }
      case 'page.wait': {
        const condition = command.condition ?? (command.selector ? 'target' : 'time');
        return this.waitForCondition(
          tabId,
          condition,
          command.selector,
          command.timeMs,
          command.timeoutMs,
          command.idleMs,
          command.frameId
        );
      }
      case 'page.dialog.respond':
        await this.send(tabId, 'Page.handleJavaScriptDialog', {
          accept: command.accept,
          ...(command.promptText === undefined ? {} : { promptText: command.promptText }),
        });
        return { tabId, accepted: command.accept };
      case 'page.screenshot':
        return this.screenshot(tabId, command.format, command.quality, command.fullPage);
      case 'page.upload': {
        const backendNodeId = await this.resolveBackendNode(
          tabId,
          command.selector,
          command.frameId
        );
        await this.send(tabId, 'DOM.setFileInputFiles', {
          backendNodeId,
          files: command.filePaths,
        });
        return {
          tabId,
          uploaded: true,
          selector: command.selector,
          files: command.filePaths.length,
        };
      }
      case 'page.frames': {
        const response = await this.send(tabId, 'Page.getFrameTree');
        return { tabId, frames: flattenFrameTree(response.frameTree) };
      }
      case 'page.media':
        return this.discoverMedia(tabId, command.maxItems);
      case 'page.download':
        return this.startMediaDownload(tabId, command.ref);
      case 'page.logs': {
        const records = (this.logsByTab.get(tabId) ?? []).filter(record => {
          if (!command.level) return true;
          const entry = record.data.entry as Record<string, unknown> | undefined;
          return entry?.level === command.level;
        });
        return { tabId, entries: records.slice(-(command.limit ?? 100)) };
      }
      case 'page.network': {
        const records = (this.networkByTab.get(tabId) ?? []).filter(record => {
          if (!command.urlIncludes) return true;
          const request = record.data.request as Record<string, unknown> | undefined;
          const response = record.data.response as Record<string, unknown> | undefined;
          const url = request?.url ?? response?.url;
          return typeof url === 'string' && url.includes(command.urlIncludes);
        });
        return { tabId, entries: records.slice(-(command.limit ?? 100)) };
      }
      case 'page.emulate':
        return this.emulate(tabId, command);
      case 'page.release':
        return { tabId, released: await this.release(tabId) };
      default:
        throw new Error(`Unsupported page action: ${(command as { action: string }).action}`);
    }
  }

  private async navigateHistory(
    tabId: number,
    operation: Extract<BrowserPageCommand, { action: 'page.history' }>['operation']
  ): Promise<unknown> {
    if (operation === 'reload') {
      await this.send(tabId, 'Page.reload', {});
      return { tabId, operation };
    }
    if (operation === 'stop') {
      await this.send(tabId, 'Page.stopLoading', {});
      return { tabId, operation };
    }

    const history = await this.send(tabId, 'Page.getNavigationHistory');
    const entries = Array.isArray(history.entries)
      ? (history.entries as Array<Record<string, unknown>>)
      : [];
    const currentIndex = typeof history.currentIndex === 'number' ? history.currentIndex : -1;
    const targetIndex = operation === 'back' ? currentIndex - 1 : currentIndex + 1;
    const entry = entries[targetIndex];
    if (typeof entry?.id !== 'number') throw new Error(`Cannot navigate ${operation}`);
    await this.send(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id });
    return { tabId, operation, url: entry.url };
  }

  private async clickNode(
    tabId: number,
    backendNodeId: number,
    button: 'left' | 'right' | 'middle' = 'left',
    clickCount = 1
  ): Promise<{ x: number; y: number }> {
    await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const point = await this.nodeCenter(tabId, backendNodeId);
    await this.dispatchClick(tabId, point, button, clickCount);
    return point;
  }

  private async dispatchClick(
    tabId: number,
    point: { x: number; y: number },
    button: 'left' | 'right' | 'middle',
    clickCount: number
  ): Promise<void> {
    for (let currentCount = 1; currentCount <= clickCount; currentCount += 1) {
      await this.send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...point,
        button,
        clickCount: currentCount,
      });
      await this.send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...point,
        button,
        clickCount: currentCount,
      });
    }
  }

  private async callFunctionOn<T>(
    tabId: number,
    backendNodeId: number,
    functionDeclaration: string,
    args: unknown[] = []
  ): Promise<T> {
    const resolved = await this.send(tabId, 'DOM.resolveNode', { backendNodeId });
    const object = resolved.object as Record<string, unknown> | undefined;
    if (typeof object?.objectId !== 'string') throw new Error('Unable to inspect target element');
    const response = await this.send(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration,
      arguments: args.map(value => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    const exception = response.exceptionDetails as Record<string, unknown> | undefined;
    if (exception)
      throw new Error(`Element operation failed: ${String(exception.text ?? 'unknown')}`);
    const result = response.result as Record<string, unknown> | undefined;
    return result?.value as T;
  }

  private async waitForCondition(
    tabId: number,
    condition: 'target' | 'time' | 'navigation' | 'networkIdle' | 'popup' | 'download',
    selector?: string,
    timeMs?: number,
    timeoutMs = 10_000,
    idleMs = 500,
    frameId?: string
  ): Promise<unknown> {
    if (condition === 'time') {
      const duration = timeMs ?? 500;
      await new Promise(resolve => setTimeout(resolve, duration));
      return { tabId, waitedMs: duration };
    }
    if (condition === 'target') return this.wait(tabId, selector, 0, timeoutMs, frameId);
    if (condition === 'navigation') {
      await this.waitForDebuggerEvent(
        tabId,
        ['Page.loadEventFired', 'Page.frameStoppedLoading'],
        timeoutMs
      );
      return { tabId, navigation: true };
    }
    if (condition === 'popup') return this.waitForPopup(tabId, timeoutMs);
    if (condition === 'download') return this.waitForDownload(tabId, timeoutMs);
    return this.waitForNetworkIdle(tabId, timeoutMs, idleMs);
  }

  private waitForDebuggerEvent(tabId: number, methods: string[], timeoutMs: number): Promise<void> {
    const debuggerEvents = this.debuggerApi?.onEvent;
    if (!debuggerEvents) return Promise.reject(new Error('Chrome CDP control is unavailable'));
    return new Promise((resolve, reject) => {
      const listener = (source: chrome.debugger.Debuggee, method: string): void => {
        if (source.tabId !== tabId || !methods.includes(method)) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${methods.join(' or ')}`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        debuggerEvents.removeListener(listener);
      };
      debuggerEvents.addListener(listener);
    });
  }

  private waitForPopup(tabId: number, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const listener = (tab: chrome.tabs.Tab): void => {
        if (tab.openerTabId !== tabId || tab.id === undefined) return;
        cleanup();
        resolve({ tabId, popupTabId: tab.id, windowId: tab.windowId, url: tab.url ?? '' });
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for popup tab'));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        chrome.tabs.onCreated.removeListener(listener);
      };
      chrome.tabs.onCreated.addListener(listener);
    });
  }

  private waitForDownload(tabId: number, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const listener = (item: chrome.downloads.DownloadItem): void => {
        cleanup();
        resolve({ tabId, downloadId: `chrome:${item.id}`, url: sanitizeUrl(item.url) });
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for download'));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        chrome.downloads.onCreated.removeListener(listener);
      };
      chrome.downloads.onCreated.addListener(listener);
    });
  }

  private async waitForNetworkIdle(
    tabId: number,
    timeoutMs: number,
    idleMs: number
  ): Promise<unknown> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const inFlight = this.inFlightRequestsByTab.get(tabId)?.size ?? 0;
      const lastActivity = this.lastNetworkActivityByTab.get(tabId) ?? startedAt;
      if (inFlight === 0 && Date.now() - lastActivity >= idleMs) {
        return { tabId, networkIdle: true, waitedMs: Date.now() - startedAt };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for network idle');
  }

  private async ensureAttached(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
    const pending = this.attachingTabs.get(tabId);
    if (pending) return pending;

    const attachment = (async () => {
      await chrome.debugger.attach({ tabId }, CDP_VERSION);
      this.attachedTabs.add(tabId);
      try {
        await Promise.all([
          this.send(tabId, 'Page.enable'),
          this.send(tabId, 'DOM.enable'),
          this.send(tabId, 'Runtime.enable'),
          this.send(tabId, 'Accessibility.enable'),
          this.send(tabId, 'Log.enable'),
          this.send(tabId, 'Network.enable', {
            maxTotalBufferSize: 10_000_000,
            maxResourceBufferSize: 2_000_000,
          }),
        ]);
      } catch (error) {
        await this.release(tabId);
        throw error;
      }
    })();
    this.attachingTabs.set(tabId, attachment);
    try {
      await attachment;
    } finally {
      if (this.attachingTabs.get(tabId) === attachment) this.attachingTabs.delete(tabId);
    }
  }

  private send(tabId: number, method: string, params?: CdpParams): Promise<CdpResult> {
    const sendCommand = chrome.debugger.sendCommand as unknown as (
      target: chrome.debugger.Debuggee,
      method: string,
      params?: CdpParams
    ) => Promise<CdpResult>;
    return sendCommand({ tabId }, method, params);
  }

  private async frameExecutionContextId(tabId: number, frameId: string): Promise<number> {
    const world = await this.send(tabId, 'Page.createIsolatedWorld', {
      frameId,
      worldName: 'EV Browser',
      grantUniversalAccess: false,
    });
    if (typeof world.executionContextId !== 'number') {
      throw new Error(`Unable to access frame: ${frameId}`);
    }
    return world.executionContextId;
  }

  private async evaluate<T = unknown>(
    tabId: number,
    expression: string,
    frameId?: string
  ): Promise<T> {
    const contextId = frameId ? await this.frameExecutionContextId(tabId, frameId) : undefined;
    const response = await this.send(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
      ...(contextId === undefined ? {} : { contextId }),
    });
    const exception = response.exceptionDetails as Record<string, unknown> | undefined;
    if (exception) throw new Error(`CDP evaluation failed: ${String(exception.text ?? 'unknown')}`);
    const result = response.result as Record<string, unknown> | undefined;
    return result?.value as T;
  }

  private async snapshot(
    tabId: number,
    mode: 'full' | 'interactive',
    maxNodes = 500,
    maxChars = 100_000,
    frameId?: string
  ): Promise<unknown> {
    const response = await this.send(
      tabId,
      'Accessibility.getFullAXTree',
      frameId ? { frameId } : undefined
    );
    const source = Array.isArray(response.nodes) ? (response.nodes as AxNode[]) : [];
    const refs = new Map<string, number>();
    const nodes: Array<Record<string, unknown>> = [];
    const eligibleNodes = source.filter(node => {
      if (node.ignored || node.backendDOMNodeId === undefined) return false;
      return mode === 'full' || INTERACTIVE_ROLES.has(stringValue(node.role));
    });
    let encodedChars = 0;

    for (const node of eligibleNodes) {
      const role = stringValue(node.role);
      const name = stringValue(node.name);
      const ref = `@e${nodes.length + 1}`;
      const value: Record<string, unknown> = { ref, role, name };
      const description = stringValue(node.description);
      if (description) value.description = description;
      const nextChars = JSON.stringify(value).length;
      if (nodes.length >= maxNodes || encodedChars + nextChars > maxChars) break;
      encodedChars += nextChars;
      const backendNodeId = node.backendDOMNodeId;
      if (backendNodeId === undefined) continue;
      refs.set(ref, backendNodeId);
      nodes.push(value);
    }

    this.refsByTab.set(tabId, refs);
    this.domRefsByTab.delete(tabId);
    return {
      tabId,
      mode,
      ...(frameId ? { frameId } : {}),
      nodes,
      truncated: nodes.length < eligibleNodes.length,
    };
  }

  /**
   * Resolve the target node and, when action visualization is enabled, show
   * the short-lived highlight on it before the caller performs the action.
   */
  private async resolveAndHighlight(
    tabId: number,
    requestedSelector: string,
    frameId: string | undefined,
    label: string
  ): Promise<number> {
    const backendNodeId = await this.resolveBackendNode(tabId, requestedSelector, frameId);
    await this.highlightResolvedNode(tabId, backendNodeId, frameId, label);
    return backendNodeId;
  }

  private async highlightResolvedNode(
    tabId: number,
    backendNodeId: number,
    frameId: string | undefined,
    label: string
  ): Promise<void> {
    if (frameId) return;
    if (!(await isActionHighlightEnabled())) return;
    try {
      await this.callFunctionOn(tabId, backendNodeId, cdpHighlightDeclaration(), [label]);
    } catch {
      // Highlights are cosmetic; never fail the surrounding action.
    }
  }

  private async resolveBackendNode(
    tabId: number,
    requestedSelector: string,
    frameId?: string
  ): Promise<number> {
    let selector = requestedSelector;
    if (selector.startsWith('@e')) {
      const backendNodeId = this.refsByTab.get(tabId)?.get(selector);
      if (backendNodeId !== undefined) return backendNodeId;
      const domSelector = this.domRefsByTab.get(tabId)?.get(selector);
      if (!domSelector) throw new Error(`Snapshot ref is missing or stale: ${selector}`);
      selector = domSelector;
    }

    let nodeId: number | undefined;
    if (frameId) {
      const contextId = await this.frameExecutionContextId(tabId, frameId);
      const evaluated = await this.send(tabId, 'Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        contextId,
        returnByValue: false,
      });
      const result = evaluated.result as Record<string, unknown> | undefined;
      if (typeof result?.objectId !== 'string') throw new Error(`Element not found: ${selector}`);
      const requested = await this.send(tabId, 'DOM.requestNode', { objectId: result.objectId });
      if (typeof requested.nodeId === 'number') nodeId = requested.nodeId;
    } else {
      const documentResponse = await this.send(tabId, 'DOM.getDocument', {
        depth: 0,
        pierce: true,
      });
      const root = documentResponse.root as Record<string, unknown> | undefined;
      if (typeof root?.nodeId !== 'number') throw new Error('Unable to inspect page DOM');
      const queryResponse = await this.send(tabId, 'DOM.querySelector', {
        nodeId: root.nodeId,
        selector,
      });
      if (typeof queryResponse.nodeId === 'number' && queryResponse.nodeId !== 0) {
        nodeId = queryResponse.nodeId;
      }
    }
    if (nodeId === undefined) throw new Error(`Element not found: ${selector}`);
    const describeResponse = await this.send(tabId, 'DOM.describeNode', { nodeId });
    const node = describeResponse.node as Record<string, unknown> | undefined;
    if (typeof node?.backendNodeId !== 'number') throw new Error(`Element not found: ${selector}`);
    return node.backendNodeId;
  }

  private async nodeCenter(
    tabId: number,
    backendNodeId: number
  ): Promise<{ x: number; y: number }> {
    const response = await this.send(tabId, 'DOM.getBoxModel', { backendNodeId });
    const model = response.model as Record<string, unknown> | undefined;
    const quad = (model?.content ?? model?.border) as number[] | undefined;
    if (!quad || quad.length < 8) throw new Error('Element has no visible box');
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    return {
      x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
      y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
    };
  }

  private async clearEditable(tabId: number, backendNodeId: number): Promise<void> {
    const resolved = await this.send(tabId, 'DOM.resolveNode', { backendNodeId });
    const object = resolved.object as Record<string, unknown> | undefined;
    if (typeof object?.objectId !== 'string') throw new Error('Unable to edit target element');
    await this.send(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
          const prototype = this instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(this, '');
        } else if (this instanceof HTMLElement && this.isContentEditable) {
          this.textContent = '';
        } else {
          throw new Error('Target is not editable');
        }
        this.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      returnByValue: true,
    });
  }

  private async wait(
    tabId: number,
    selector?: string,
    timeMs = selector ? 0 : 500,
    timeoutMs = 10_000,
    frameId?: string
  ): Promise<unknown> {
    if (timeMs > 0) await new Promise(resolve => setTimeout(resolve, timeMs));
    if (!selector) return { tabId, waitedMs: timeMs };

    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      try {
        await this.resolveBackendNode(tabId, selector, frameId);
        return { tabId, found: true, selector, waitedMs: Date.now() - startedAt };
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    throw new Error(`Timed out waiting for element: ${selector}`);
  }

  private async screenshot(
    tabId: number,
    format: 'png' | 'jpeg' = 'png',
    quality = 90,
    fullPage = false
  ): Promise<unknown> {
    let clip: Record<string, number> | undefined;
    if (fullPage) {
      const metrics = await this.send(tabId, 'Page.getLayoutMetrics');
      const size = (metrics.cssContentSize ?? metrics.contentSize) as
        Record<string, unknown> | undefined;
      if (typeof size?.width === 'number' && typeof size.height === 'number') {
        clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
      }
    }
    const response = await this.send(tabId, 'Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality } : {}),
      fromSurface: true,
      captureBeyondViewport: fullPage,
      ...(clip ? { clip } : {}),
    });
    return { tabId, format, data: response.data, fullPage };
  }

  private async discoverMedia(tabId: number, maxItems = 100): Promise<unknown> {
    const scan = await this.evaluate<DomMediaScan>(
      tabId,
      `(() => {
        const items = [];
        let skippedBlobMedia = 0;
        const add = (kind, url, metadata = {}) => {
          if (!url || items.length >= ${MAX_MEDIA_SCAN_ITEMS}) return;
          if (url.startsWith('blob:')) {
            skippedBlobMedia += 1;
            return;
          }
          items.push({ kind, url, ...metadata });
        };
        for (const image of document.images) {
          add('image', image.currentSrc || image.src, {
            width: image.naturalWidth || image.width,
            height: image.naturalHeight || image.height,
          });
        }
        for (const video of document.querySelectorAll('video')) {
          const metadata = {
            width: video.videoWidth || video.clientWidth,
            height: video.videoHeight || video.clientHeight,
            duration: Number.isFinite(video.duration) ? video.duration : undefined,
          };
          add('video', video.currentSrc || video.src, metadata);
          for (const source of video.querySelectorAll('source')) {
            add('video', source.src, { ...metadata, mimeType: source.type || undefined });
          }
          add('image', video.poster, {
            width: video.videoWidth || video.clientWidth,
            height: video.videoHeight || video.clientHeight,
          });
        }
        return {
          pageUrl: location.href,
          items,
          resourceUrls: performance.getEntriesByType('resource').slice(-${MAX_MEDIA_SCAN_ITEMS}).map(entry => entry.name),
          skippedBlobMedia,
        };
      })()`
    );

    const candidates: Array<
      Omit<CachedMediaItem, 'item'> & Omit<BrowserMediaItem, 'ref' | 'url' | 'filename'>
    > = [];
    for (const item of scan.items) {
      if (!httpUrl(item.url)) continue;
      const kind = isStreamMedia(item.url, item.mimeType) ? 'stream' : item.kind;
      candidates.push({
        rawUrl: item.url,
        pageUrl: scan.pageUrl,
        kind,
        source: 'dom',
        mimeType: item.mimeType,
        width: item.width,
        height: item.height,
        duration: item.duration,
      });
    }
    const networkCandidates: RawNetworkMedia[] = [
      ...scan.resourceUrls.map(url => ({ url })),
      ...(this.rawNetworkMediaByTab.get(tabId) ?? []),
    ];
    for (const item of networkCandidates) {
      if (!httpUrl(item.url) || !isNetworkMedia(item.url, item.mimeType)) continue;
      candidates.push({
        rawUrl: item.url,
        pageUrl: scan.pageUrl,
        kind: 'stream',
        source: 'network',
        mimeType: item.mimeType,
      });
    }

    const seenUrls = new Set<string>();
    const unique = [];
    for (const candidate of candidates) {
      if (seenUrls.has(candidate.rawUrl)) continue;
      seenUrls.add(candidate.rawUrl);
      unique.push(candidate);
      if (unique.length > maxItems) break;
    }
    const refs = new Map<string, CachedMediaItem>();
    const items = unique.slice(0, maxItems).map((candidate, index): BrowserMediaItem => {
      const ref = `@m${index + 1}`;
      const item: BrowserMediaItem = {
        ref,
        kind: candidate.kind,
        source: candidate.source,
        url: publicMediaUrl(candidate.rawUrl),
        filename: mediaFilename(candidate.rawUrl, candidate.kind, candidate.mimeType),
        ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
        ...(candidate.width === undefined ? {} : { width: candidate.width }),
        ...(candidate.height === undefined ? {} : { height: candidate.height }),
        ...(candidate.duration === undefined ? {} : { duration: candidate.duration }),
      };
      refs.set(ref, { rawUrl: candidate.rawUrl, pageUrl: candidate.pageUrl, item });
      return item;
    });
    this.mediaByTab.set(tabId, refs);
    return BrowserMediaResultSchema.parse({
      tabId,
      pageUrl: scan.pageUrl,
      items,
      truncated: items.length < unique.length,
      skippedBlobMedia: scan.skippedBlobMedia,
    });
  }

  private async startMediaDownload(tabId: number, ref: string): Promise<unknown> {
    const media = this.mediaByTab.get(tabId)?.get(ref);
    if (!media) throw new Error(`Media ref is missing or stale: ${ref}`);
    const allowed = await chrome.permissions.contains({ permissions: ['downloads'] });
    if (!allowed) throw new Error('Media downloads are disabled in EV Browser settings');

    if (media.item.kind === 'stream') {
      return BrowserDownloadDispatchSchema.parse({
        backend: 'external',
        url: media.rawUrl,
        pageUrl: media.pageUrl,
        mediaKind: 'stream',
      });
    }

    const downloadId = await chrome.downloads.download({
      url: media.rawUrl,
      filename: `EV/${media.item.filename}`,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    return BrowserDownloadDispatchSchema.parse({ backend: 'chrome', downloadId });
  }

  private async downloadStatus(downloadId: string): Promise<unknown> {
    const match = /^chrome:(\d+)$/.exec(downloadId);
    if (!match) throw new Error(`Unsupported Extension download ID: ${downloadId}`);
    const allowed = await chrome.permissions.contains({ permissions: ['downloads'] });
    if (!allowed) throw new Error('Media downloads are disabled in EV Browser settings');
    const [item] = await chrome.downloads.search({ id: Number(match[1]) });
    if (!item) throw new Error(`Download not found: ${downloadId}`);
    return BrowserDownloadStatusSchema.parse({
      downloadId,
      backend: 'chrome',
      state: item.state,
      ...(item.filename ? { filename: item.filename } : {}),
      ...(item.error ? { error: item.error } : {}),
    });
  }

  private async emulate(
    tabId: number,
    command: Extract<BrowserAtomicCommand, { action: 'page.emulate' }>
  ): Promise<unknown> {
    if (!command.enabled) {
      await this.send(tabId, 'Emulation.clearDeviceMetricsOverride');
      await this.send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false });
      return { tabId, enabled: false };
    }
    const value = {
      width: command.width ?? 390,
      height: command.height ?? 844,
      deviceScaleFactor: command.deviceScaleFactor ?? 3,
      mobile: command.mobile ?? true,
      touch: command.touch ?? true,
    };
    await this.send(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: value.width,
      height: value.height,
      deviceScaleFactor: value.deviceScaleFactor,
      mobile: value.mobile,
    });
    await this.send(tabId, 'Emulation.setTouchEmulationEnabled', {
      enabled: value.touch,
      maxTouchPoints: value.touch ? 5 : 1,
    });
    return { tabId, enabled: true, ...value };
  }

  /**
   * The debugger infobar stays visible for as long as the attachment is held,
   * so hold it only while advanced commands are in flight plus a short quiet
   * window, then release; the next advanced command re-attaches on demand.
   */
  private async withAdvancedLease<T>(tabId: number, run: () => Promise<T>): Promise<T> {
    this.clearIdleDebuggerRelease(tabId);
    this.inFlightAdvancedByTab.set(tabId, (this.inFlightAdvancedByTab.get(tabId) ?? 0) + 1);
    try {
      return await run();
    } finally {
      const left = (this.inFlightAdvancedByTab.get(tabId) ?? 1) - 1;
      if (left <= 0) this.inFlightAdvancedByTab.delete(tabId);
      else this.inFlightAdvancedByTab.set(tabId, left);
      this.scheduleIdleDebuggerRelease(tabId);
    }
  }

  private scheduleIdleDebuggerRelease(tabId: number): void {
    this.clearIdleDebuggerRelease(tabId);
    this.debuggerIdleTimers.set(
      tabId,
      setTimeout(() => {
        this.debuggerIdleTimers.delete(tabId);
        if ((this.inFlightAdvancedByTab.get(tabId) ?? 0) === 0) void this.release(tabId);
      }, DEBUGGER_IDLE_RELEASE_MS)
    );
  }

  private clearIdleDebuggerRelease(tabId: number): void {
    const timer = this.debuggerIdleTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      this.debuggerIdleTimers.delete(tabId);
    }
  }

  private async release(tabId: number): Promise<boolean> {
    this.clearIdleDebuggerRelease(tabId);
    this.domRefsByTab.delete(tabId);
    this.refsByTab.delete(tabId);
    if (!this.attachedTabs.has(tabId)) return false;
    this.attachedTabs.delete(tabId);
    this.mediaByTab.delete(tabId);
    this.logsByTab.delete(tabId);
    this.networkByTab.delete(tabId);
    this.rawNetworkMediaByTab.delete(tabId);
    await chrome.debugger.detach({ tabId });
    return true;
  }
}

let controller: CdpBrowserController | undefined;

function getController(): CdpBrowserController {
  controller ??= new CdpBrowserController();
  return controller;
}

export async function executeBrowserCommand(command: BrowserAtomicCommand): Promise<unknown> {
  const debuggerApi = (chrome as unknown as { debugger?: typeof chrome.debugger }).debugger;
  if (
    !debuggerApi &&
    command.action.startsWith('page.') &&
    !command.action.startsWith('page.webmcp.')
  ) {
    throw new Error('Chrome CDP control is unavailable in this browser');
  }
  return getController().execute(command);
}

export function resetBrowserControllerForTests(): void {
  controller?.dispose();
  controller = undefined;
}
