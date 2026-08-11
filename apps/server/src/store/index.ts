import { getBackend } from './backend';

/**
 * electron-store-shaped API over SQLite (~/.ev/ev.db), the M1 source of truth.
 * Service code stays untouched: get/set semantics match the JSON era; values are
 * JSON blobs in the KV table. The driver seam lives in ./backend
 * (better-sqlite3 / node:sqlite implementations).
 */
export default class Store<T extends object> {
  constructor(
    private readonly options: { name?: string; defaults?: Partial<T>; clearInvalidConfig?: boolean }
  ) {}

  private get storeName(): string {
    return this.options.name ?? 'config';
  }

  get = <K extends keyof T>(key: K): T[K] => {
    const raw = getBackend().get(this.storeName, key as string);
    if (raw !== null) {
      try {
        return JSON.parse(raw) as T[K];
      } catch {
        // corrupt values fall back to defaults instead of breaking startup.
      }
    }
    return (this.options.defaults as Record<string, unknown> | undefined)?.[key as string] as T[K];
  };

  set = (key: string, value: unknown): void => {
    getBackend().set(this.storeName, key, JSON.stringify(value));
  };
}
