import { getBackend } from './backend';


/**
 * electron-store 同形 API，SQLite（~/.ev/ev.db）后端（M1 事实源）。
 * 服务代码零改动：get/set 语义与 JSON 时代一致；值以 JSON blob 存 KV 表。
 * 驱动缝在 ./backend（bun:sqlite / node:sqlite 双实现）。
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
        // 坏值落回默认，不炸启动。
      }
    }
    return (this.options.defaults as Record<string, unknown> | undefined)?.[key as string] as T[K];
  };

  set = (key: string, value: unknown): void => {
    getBackend().set(this.storeName, key, JSON.stringify(value));
  };
}
