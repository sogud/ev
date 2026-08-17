import { ACTION_HIGHLIGHT_STORAGE_KEY } from '../content/action-highlight';
import { requestActionHighlight } from './webmcp-bridge';

/**
 * Settings-backed gate for action visualization. The flag is cached after the
 * first read and refreshed through storage change events, so a disabled
 * highlight adds no per-action work beyond one boolean check.
 */

let cachedEnabled: boolean | undefined;
let subscribed = false;

function storageApi(): chrome.storage.StorageArea | undefined {
  return (chrome as unknown as { storage?: typeof chrome.storage }).storage?.sync;
}

function subscribeToStorageChanges(): void {
  if (subscribed) return;
  const storage = (chrome as unknown as { storage?: typeof chrome.storage }).storage;
  if (!storage?.onChanged) return;
  subscribed = true;
  storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    const change = changes[ACTION_HIGHLIGHT_STORAGE_KEY];
    if (!change) return;
    cachedEnabled = change.newValue !== false;
  });
}

/** Resolve the highlight switch; defaults to enabled when unset. */
export async function isActionHighlightEnabled(): Promise<boolean> {
  if (cachedEnabled !== undefined) return cachedEnabled;
  const sync = storageApi();
  if (!sync) {
    cachedEnabled = true;
    return cachedEnabled;
  }
  subscribeToStorageChanges();
  try {
    const stored = await sync.get(ACTION_HIGHLIGHT_STORAGE_KEY);
    cachedEnabled = stored[ACTION_HIGHLIGHT_STORAGE_KEY] !== false;
  } catch {
    cachedEnabled = true;
  }
  return cachedEnabled;
}

/** Highlight a target element before acting on it; never throws. */
export async function highlightBeforeAction(
  tabId: number,
  selector: string,
  label: string
): Promise<void> {
  if (!(await isActionHighlightEnabled())) return;
  await requestActionHighlight(tabId, selector, label);
}

export function resetActionHighlightForTests(): void {
  cachedEnabled = undefined;
  subscribed = false;
}
