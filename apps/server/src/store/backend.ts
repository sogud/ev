import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

/**
 * KV driver: better-sqlite3 preferred, JSON fallback. The native binding is
 * loaded lazily so an ABI mismatch (e.g. ELECTRON_RUN_AS_NODE fallback with a
 * system-node-built binding) degrades to the JSON backend instead of crashing
 * the server; JSON files use the legacy layout and migrate back to sqlite on
 * the next healthy start.
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
// no injection surface; node:sqlite ships no query builder and the
// mission forbids new external dependencies.
const SQL = {
  createTable:
    'CREATE TABLE IF NOT EXISTS kv (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (store, key))',
  wal: 'PRAGMA journal_mode = WAL',
  get: 'SELECT value FROM kv WHERE store = ? AND key = ?',
  set: 'INSERT INTO kv (store, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (store, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  count: 'SELECT COUNT(*) AS n FROM kv WHERE store = ?',
} as const;

// Lazy require: keeps the native binding out of module-init so its load error
// is catchable; also keeps the externalized module resolvable next to the bundle.
function loadSqlite(): typeof Database {
  return createRequire(import.meta.url)('better-sqlite3');
}

class SqliteKv implements KvBackend {
  private readonly db: Database.Database;

  constructor(path: string) {
    const DatabaseCtor = loadSqlite();
    this.db = new DatabaseCtor(path);
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

/**
 * File-per-store JSON backend (legacy layout). Values are persisted decoded so
 * the files double as the legacy migration source when sqlite becomes available.
 *
 * Contract: KV (both backends) is for small configuration data — settings and
 * preferences. Every JsonKv set rewrites the whole file, and this class is the
 * NORMAL path on packaged machines without a system node (ELECTRON_RUN_AS_NODE
 * fallback), so bulk data (task bodies, transcripts, raw traces) must not be
 * stored in KV. When sqlite is available again, stored files migrate back
 * automatically via migrateLegacyJson.
 */
export class JsonKv implements KvBackend {
  private readonly cache = new Map<string, Record<string, unknown>>();

  constructor(private readonly dir: string) {}

  private file(store: string): string {
    return join(this.dir, `${store}.json`);
  }

  private load(store: string): Record<string, unknown> {
    let data = this.cache.get(store);
    if (data) return data;
    try {
      const parsed = JSON.parse(readFileSync(this.file(store), 'utf8')) as Record<string, unknown>;
      data = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      data = {};
    }
    this.cache.set(store, data);
    return data;
  }

  private flush(store: string): void {
    writeFileSync(this.file(store), JSON.stringify(this.load(store), null, 2), { mode: 0o600 });
  }

  get(store: string, key: string): string | null {
    const value = this.load(store)[key];
    return value === undefined ? null : JSON.stringify(value);
  }

  set(store: string, key: string, value: string): void {
    this.load(store)[key] = JSON.parse(value) as unknown;
    this.flush(store);
  }

  count(store: string): number {
    return Object.keys(this.load(store)).length;
  }

  close(): void {
    this.cache.clear();
  }
}

let backend: KvBackend | null = null;

export function getBackend(): KvBackend {
  if (backend) return backend;
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.env.EV_JSON_STORE === '1') {
    backend = new JsonKv(dir);
  } else {
    try {
      backend = new SqliteKv(join(dir, 'ev.db'));
    } catch (error) {
      console.error(
        `[EV] sqlite unavailable (${error instanceof Error ? error.message : String(error)}); ` +
          'falling back to the JSON store'
      );
      backend = new JsonKv(dir);
    }
  }
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
