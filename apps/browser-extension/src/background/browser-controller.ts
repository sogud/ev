import {
  BrowserDownloadDispatchSchema,
  BrowserDownloadStatusSchema,
  BrowserMediaResultSchema,
  type BrowserAtomicCommand,
  type BookmarkBackupNode,
  type BrowserMediaItem,
} from '@ev/contracts';

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
const CDP_ACTIONS = [
  'tabs.list',
  'windows.open',
  'tabs.open',
  'tabs.close',
  'tabs.activate',
  'page.navigate',
  'page.context',
  'page.snapshot',
  'page.click',
  'page.type',
  'page.hover',
  'page.press',
  'page.scroll',
  'page.wait',
  'page.screenshot',
  'page.upload',
  'page.frames',
  'page.media',
  'page.download',
  'downloads.status',
  'page.logs',
  'page.network',
  'page.emulate',
  'page.release',
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

function assertWebUrl(value: string): void {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol)) return;
  } catch {
    // Fall through to the stable boundary error below.
  }
  throw new Error('Only HTTP(S) pages can be controlled');
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('No active browser tab');
  return tab.id;
}

async function resolveTab(tabId?: number): Promise<chrome.tabs.Tab> {
  const id = tabId ?? (await activeTabId());
  const tab = await chrome.tabs.get(id);
  if (!tab.url) throw new Error(`Tab ${id} has no URL`);
  assertWebUrl(tab.url);
  return tab;
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

const KEY_DEFINITIONS: Record<
  Extract<BrowserAtomicCommand, { action: 'page.press' }>['key'],
  { key: string; code: string; keyCode: number; text?: string }
> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
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

class CdpBrowserController {
  private readonly debuggerApi = (chrome as unknown as { debugger?: typeof chrome.debugger })
    .debugger;
  private readonly attachedTabs = new Set<number>();
  private readonly refsByTab = new Map<number, Map<string, number>>();
  private readonly mediaByTab = new Map<number, Map<string, CachedMediaItem>>();
  private readonly logsByTab = new Map<number, BrowserEventRecord[]>();
  private readonly networkByTab = new Map<number, BrowserEventRecord[]>();
  private readonly rawNetworkMediaByTab = new Map<number, RawNetworkMedia[]>();

  private readonly handleEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object
  ): void => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    if (method === 'Network.responseReceived' && params) {
      const response = (params as CdpParams).response as Record<string, unknown> | undefined;
      const url = response?.url;
      const mimeType = response?.mimeType;
      if (
        typeof url === 'string' &&
        (mimeType === undefined || typeof mimeType === 'string') &&
        isStreamMedia(url, mimeType)
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
    this.attachedTabs.delete(source.tabId);
    this.refsByTab.delete(source.tabId);
    this.mediaByTab.delete(source.tabId);
    this.rawNetworkMediaByTab.delete(source.tabId);
  };

  constructor() {
    this.debuggerApi?.onEvent.addListener(this.handleEvent);
    this.debuggerApi?.onDetach.addListener(this.handleDetach);
  }

  dispose(): void {
    this.debuggerApi?.onEvent.removeListener(this.handleEvent);
    this.debuggerApi?.onDetach.removeListener(this.handleDetach);
  }

  async execute(command: BrowserAtomicCommand): Promise<unknown> {
    switch (command.action) {
      case 'browser.capabilities':
        return {
          transport: this.debuggerApi ? 'cdp' : 'unavailable',
          cdp: Boolean(this.debuggerApi),
          arbitraryEval: false,
          actions: this.debuggerApi ? [...CDP_ACTIONS, ...BOOKMARK_ACTIONS] : [...BOOKMARK_ACTIONS],
        };
      case 'tabs.list': {
        const tabs = await chrome.tabs.query({});
        return tabs.flatMap(tab =>
          tab.id === undefined
            ? []
            : [
                {
                  id: tab.id,
                  windowId: tab.windowId,
                  active: tab.active,
                  title: tab.title ?? '',
                  url: tab.url ?? '',
                  cdpAttached: this.attachedTabs.has(tab.id),
                },
              ]
        );
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
      case 'tabs.open': {
        assertWebUrl(command.url);
        const tab = await chrome.tabs.create({
          url: command.url,
          ...(command.windowId !== undefined ? { windowId: command.windowId } : {}),
          active: command.active ?? true,
        });
        if (tab.id === undefined) throw new Error('Chrome did not return the created tab');
        return { id: tab.id, windowId: tab.windowId, url: tab.url || command.url };
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
      case 'page.release': {
        const tabId = command.tabId ?? (await activeTabId());
        return { tabId, released: await this.release(tabId) };
      }
      case 'downloads.status':
        return this.downloadStatus(command.downloadId);
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
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.url !== undefined ? { url: command.url } : {}),
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
        return this.executePageCommand(command);
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

  private async executePageCommand(
    command: Exclude<
      BrowserAtomicCommand,
      | { action: 'browser.capabilities' }
      | { action: 'tabs.list' }
      | { action: 'windows.open' }
      | { action: 'tabs.open' }
      | { action: 'tabs.close' }
      | { action: 'tabs.activate' }
      | { action: 'page.release' }
      | { action: 'downloads.status' }
      | { action: 'bookmarks.list' }
      | { action: 'bookmarks.search' }
      | { action: 'bookmarks.create' }
      | { action: 'bookmarks.update' }
      | { action: 'bookmarks.move' }
      | { action: 'bookmarks.remove' }
      | { action: 'bookmarks.removeTree' }
      | { action: 'bookmarks.export' }
      | { action: 'bookmarks.restore' }
    >
  ): Promise<unknown> {
    const tab = await resolveTab(command.tabId);
    const tabId = tab.id!;
    await this.ensureAttached(tabId);

    switch (command.action) {
      case 'page.navigate': {
        const response = await this.send(tabId, 'Page.navigate', { url: command.url });
        return { tabId, url: command.url, frameId: response.frameId };
      }
      case 'page.context': {
        const maxChars = command.maxChars ?? 20_000;
        const scope = command.scope === 'main' ? `document.querySelector('main')` : 'document.body';
        return this.evaluate<Record<string, unknown>>(
          tabId,
          `(() => { const root = ${scope}; return {url: location.href, title: document.title, selection: getSelection()?.toString().slice(0, ${maxChars}) || undefined, text: (root?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, ${maxChars}), capturedAt: new Date().toISOString()}; })()`
        );
      }
      case 'page.snapshot':
        return this.snapshot(tabId, command.mode ?? 'full', command.maxNodes, command.maxChars);
      case 'page.click': {
        const backendNodeId = await this.resolveBackendNode(tabId, command.selector);
        await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
        const { x, y } = await this.nodeCenter(tabId, backendNodeId);
        await this.send(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
        await this.send(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
        return { tabId, clicked: true, selector: command.selector, x, y };
      }
      case 'page.type': {
        const backendNodeId = await this.resolveBackendNode(tabId, command.selector);
        await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
        await this.send(tabId, 'DOM.focus', { backendNodeId });
        if (command.clearFirst ?? true) await this.clearEditable(tabId, backendNodeId);
        await this.send(tabId, 'Input.insertText', { text: command.text });
        return { tabId, typed: true, selector: command.selector, textLength: command.text.length };
      }
      case 'page.hover': {
        const backendNodeId = await this.resolveBackendNode(tabId, command.selector);
        await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
        const { x, y } = await this.nodeCenter(tabId, backendNodeId);
        await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        return { tabId, hovered: true, selector: command.selector, x, y };
      }
      case 'page.press': {
        const definition = KEY_DEFINITIONS[command.key];
        const modifierMap = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
        const modifiers = (command.modifiers ?? []).reduce(
          (value, modifier) => value | modifierMap[modifier],
          0
        );
        const base = {
          key: definition.key,
          code: definition.code,
          windowsVirtualKeyCode: definition.keyCode,
          nativeVirtualKeyCode: definition.keyCode,
          modifiers,
          ...(definition.text ? { text: definition.text } : {}),
        };
        await this.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base });
        await this.send(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...base,
          text: undefined,
        });
        return { tabId, pressed: true, key: command.key, modifiers: command.modifiers ?? [] };
      }
      case 'page.scroll': {
        const distance = command.distance ?? 600;
        const expression =
          command.direction === 'top'
            ? `window.scrollTo({top: 0, behavior: 'instant'})`
            : command.direction === 'bottom'
              ? `window.scrollTo({top: document.documentElement.scrollHeight, behavior: 'instant'})`
              : `window.scrollBy({top: ${command.direction === 'down' ? distance : -distance}, behavior: 'instant'})`;
        await this.evaluate(tabId, expression);
        const position = await this.evaluate<{ x: number; y: number }>(
          tabId,
          `({x: window.scrollX, y: window.scrollY})`
        );
        return { tabId, direction: command.direction, ...position };
      }
      case 'page.wait':
        return this.wait(tabId, command.selector, command.timeMs, command.timeoutMs);
      case 'page.screenshot':
        return this.screenshot(tabId, command.format, command.quality, command.fullPage);
      case 'page.upload': {
        const backendNodeId = await this.resolveBackendNode(tabId, command.selector);
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
    }
  }

  private async ensureAttached(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
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
  }

  private send(tabId: number, method: string, params?: CdpParams): Promise<CdpResult> {
    const sendCommand = chrome.debugger.sendCommand as unknown as (
      target: chrome.debugger.Debuggee,
      method: string,
      params?: CdpParams
    ) => Promise<CdpResult>;
    return sendCommand({ tabId }, method, params);
  }

  private async evaluate<T = unknown>(tabId: number, expression: string): Promise<T> {
    const response = await this.send(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
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
    maxChars = 100_000
  ): Promise<unknown> {
    const response = await this.send(tabId, 'Accessibility.getFullAXTree');
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
      refs.set(ref, node.backendDOMNodeId!);
      nodes.push(value);
    }

    this.refsByTab.set(tabId, refs);
    return {
      tabId,
      mode,
      nodes,
      truncated: nodes.length < eligibleNodes.length,
    };
  }

  private async resolveBackendNode(tabId: number, selector: string): Promise<number> {
    if (selector.startsWith('@e')) {
      const backendNodeId = this.refsByTab.get(tabId)?.get(selector);
      if (backendNodeId === undefined) {
        throw new Error(`Snapshot ref is missing or stale: ${selector}`);
      }
      return backendNodeId;
    }

    const documentResponse = await this.send(tabId, 'DOM.getDocument', { depth: 0, pierce: true });
    const root = documentResponse.root as Record<string, unknown> | undefined;
    if (typeof root?.nodeId !== 'number') throw new Error('Unable to inspect page DOM');
    const queryResponse = await this.send(tabId, 'DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    });
    if (typeof queryResponse.nodeId !== 'number' || queryResponse.nodeId === 0) {
      throw new Error(`Element not found: ${selector}`);
    }
    const describeResponse = await this.send(tabId, 'DOM.describeNode', {
      nodeId: queryResponse.nodeId,
    });
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
    timeoutMs = 10_000
  ): Promise<unknown> {
    if (timeMs > 0) await new Promise(resolve => setTimeout(resolve, timeMs));
    if (!selector) return { tabId, waitedMs: timeMs };

    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      try {
        await this.resolveBackendNode(tabId, selector);
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
      if (!httpUrl(item.url) || !isStreamMedia(item.url, item.mimeType)) continue;
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
        ...(candidate.width !== undefined ? { width: candidate.width } : {}),
        ...(candidate.height !== undefined ? { height: candidate.height } : {}),
        ...(candidate.duration !== undefined ? { duration: candidate.duration } : {}),
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

  private async release(tabId: number): Promise<boolean> {
    if (!this.attachedTabs.has(tabId)) return false;
    this.attachedTabs.delete(tabId);
    this.refsByTab.delete(tabId);
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
  const usesBookmarks = command.action.startsWith('bookmarks.');
  if (!debuggerApi && command.action !== 'browser.capabilities' && !usesBookmarks) {
    throw new Error('Chrome CDP control is unavailable in this browser');
  }
  return getController().execute(command);
}

export function resetBrowserControllerForTests(): void {
  controller?.dispose();
  controller = undefined;
}
