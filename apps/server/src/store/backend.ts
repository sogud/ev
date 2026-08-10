import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * KV driver (M1 revision: better-sqlite3 only, pure Node runtime).
 * Deliberately unnormalized: one KV table (store/key/value); entities such as
 * tasks are stored as JSON blobs.
 */
export interface KvBackend {
  get(store: string, key: string): string | null;
  set(store: string, key: string, value: string): void;
  count(store: string): number;
  close(): void;
}

// All SQL is constant text + bound parameters (no string building), so there is
// no injection surface; bun:sqlite / node:sqlite ship no query builder and the
// mission forbids new external dependencies.
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
  return process.env.EV_DATA_DIR ?? process.env.EV_HOME?.trim() ?? join(homedir(), '.ev');
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

/** Test hook: reset the singleton before pointing at a temp dir. */
export function resetBackend(): void {
  backend?.close();
  backend = null;
}

/**
 * One-shot migration: legacy JSON (~/.ev/<name>.json and the old electron-store
 * location) -> SQLite KV. Imported only while the KV store is empty (idempotent);
 * old files are kept and a migration marker is written.
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
      if (target.count(name) > 0) continue; // migrated or pre-existing data: never overwrite
      try {
        const raw = readFileSync(join(dir, file), 'utf8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (!data || typeof data !== 'object') continue;
        for (const [key, value] of Object.entries(data)) {
          target.set(name, key, JSON.stringify(value));
        }
        imported.push(`${dir}/${file}`);
      } catch {
        // skip corrupt files without blocking startup; the old file remains for manual recovery.
      }
    }
  }
  if (imported.length > 0 && !existsSync(marker)) {
    writeFileSync(marker, JSON.stringify({ migratedAt: Date.now(), sources: imported }, null, 2), {
      mode: 0o600,
    });
  }
}
