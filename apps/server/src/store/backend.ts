import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * KV 驱动（M1 修订：better-sqlite3 单驱动，纯 Node 运行时）。
 * 不强行范式化：KV 表（store/key/value），任务等实体以 JSON blob 存值。
 */
export interface KvBackend {
  get(store: string, key: string): string | null;
  set(store: string, key: string, value: string): void;
  count(store: string): number;
  close(): void;
}

// SQL 全部为常量 + 参数绑定（无字符串拼接），注入面为零；
// bun:sqlite / node:sqlite 无官方 query builder，任务书禁止新增外部依赖。
const SQL = {
  createTable:
    'CREATE TABLE IF NOT EXISTS kv (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (store, key))',
  wal: 'PRAGMA journal_mode = WAL',
  get: 'SELECT value FROM kv WHERE store = ? AND key = ?',
  set: 'INSERT INTO kv (store, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (store, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  count: 'SELECT COUNT(*) AS n FROM kv WHERE store = ?',
} as const;

class SqliteKv implements KvBackend {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(SQL.createTable);
    this.db.exec(SQL.wal);
  }

  get(store: string, key: string): string | null {
    const row = this.db.prepare(SQL.get).get(store, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(store: string, key: string, value: string): void {
    this.db.prepare(SQL.set).run(store, key, value, Date.now());
  }

  count(store: string): number {
    const row = this.db.prepare(SQL.count).get(store) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  close(): void {
    this.db.close();
  }
}

export function dataDir(): string {
  return process.env.EV_DATA_DIR ?? join(homedir(), '.ev');
}

export function legacyDir(): string {
  return process.env.EV_LEGACY_DIR ?? join(homedir(), 'Library', 'Application Support', 'EV');
}

let backend: KvBackend | null = null;

export function getBackend(): KvBackend {
  if (backend) return backend;
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  backend = new SqliteKv(join(dir, 'ev.db'));
  migrateLegacyJson(backend);
  return backend;
}

/** 测试用：换临时目录前重置单例。 */
export function resetBackend(): void {
  backend?.close();
  backend = null;
}

/**
 * 一次性迁移：旧 JSON（~/.ev/<name>.json 与 electron-store 旧位置）→ SQLite KV。
 * 仅当该 store 在 KV 中为空时导入（幂等）；旧文件保留不删，另写迁移标记。
 */
export function migrateLegacyJson(target: KvBackend): void {
  const marker = join(dataDir(), 'migrated-to-sqlite.json');
  const sources = [dataDir(), legacyDir()];
  const imported: string[] = [];
  for (const dir of sources) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      if (['server.json', 'token', 'migrated-to-sqlite.json'].includes(file)) continue;
      const name = file.slice(0, -'.json'.length);
      if (target.count(name) > 0) continue; // 已迁/已有数据，绝不覆盖
      try {
        const raw = readFileSync(join(dir, file), 'utf8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (!data || typeof data !== 'object') continue;
        for (const [key, value] of Object.entries(data)) {
          target.set(name, key, JSON.stringify(value));
        }
        imported.push(`${dir}/${file}`);
      } catch {
        // 坏文件跳过，不阻断启动；旧文件仍在，可人工恢复。
      }
    }
  }
  if (imported.length > 0 && !existsSync(marker)) {
    writeFileSync(marker, JSON.stringify({ migratedAt: Date.now(), sources: imported }, null, 2), {
      mode: 0o600,
    });
  }
}
