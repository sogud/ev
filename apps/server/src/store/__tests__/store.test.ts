import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetBackend } from '../backend';
import Store from '../index';

let data: string;
let legacy: string;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'ev-data-'));
  legacy = mkdtempSync(join(tmpdir(), 'ev-legacy-'));
  process.env.EV_DATA_DIR = data;
  process.env.EV_LEGACY_DIR = legacy;
  resetBackend();
});

afterEach(() => {
  resetBackend();
  delete process.env.EV_DATA_DIR;
  delete process.env.EV_LEGACY_DIR;
  delete process.env.EV_JSON_STORE;
});

describe('SQLite KV store（M1）', () => {
  it('CRUD + defaults', () => {
    const store = new Store<{ theme: string; missing?: string }>({
      name: 'appearance',
      defaults: { theme: 'system' },
    });
    expect(store.get('theme')).toBe('system'); // default
    store.set('theme', 'dark');
    expect(store.get('theme')).toBe('dark');
  });

  it('persists across restart: still present after resetBackend', () => {
    const store = new Store<{ tasks: number[] }>({
      name: 'agent-desktop',
      defaults: { tasks: [] },
    });
    store.set('tasks', [1, 2, 3]);
    resetBackend(); // simulate a process restart
    const reopened = new Store<{ tasks: number[] }>({
      name: 'agent-desktop',
      defaults: { tasks: [] },
    });
    expect(reopened.get('tasks')).toEqual([1, 2, 3]);
    expect(existsSync(join(data, 'ev.db'))).toBe(true);
  });

  it('legacy JSON migration loses nothing and is idempotent', () => {
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, 'agent-desktop.json'),
      JSON.stringify({ tasks: [{ id: 'old-1' }], defaultRuntime: 'pi' })
    );
    const migrated = new Store<{ tasks: Array<{ id: string }>; defaultRuntime: string }>({
      name: 'agent-desktop',
      defaults: { tasks: [], defaultRuntime: 'pi' },
    });
    expect(migrated.get('tasks')).toEqual([{ id: 'old-1' }]);

    // write a new value after migration; a second reset (simulated reboot) must not be overwritten by the old file.
    migrated.set('tasks', [{ id: 'new-1' }]);
    resetBackend();
    const second = new Store<{ tasks: Array<{ id: string }> }>({
      name: 'agent-desktop',
      defaults: { tasks: [] },
    });
    expect(second.get('tasks')).toEqual([{ id: 'new-1' }]);
    expect(existsSync(join(data, 'migrated-to-sqlite.json'))).toBe(true);
    // old files are kept, never deleted
    expect(existsSync(join(legacy, 'agent-desktop.json'))).toBe(true);
  });
});

describe('JSON KV fallback', () => {
  it('EV_JSON_STORE=1 persists in the legacy file layout', () => {
    process.env.EV_JSON_STORE = '1';
    resetBackend();
    const store = new Store<{ theme: string }>({
      name: 'appearance',
      defaults: { theme: 'system' },
    });
    store.set('theme', 'dark');
    expect(store.get('theme')).toBe('dark');

    // values are persisted decoded (legacy layout) so a later sqlite start
    // migrates them without double-encoding.
    const file = JSON.parse(readFileSync(join(data, 'appearance.json'), 'utf8'));
    expect(file).toEqual({ theme: 'dark' });

    resetBackend();
    const reopened = new Store<{ theme: string }>({
      name: 'appearance',
      defaults: { theme: 'system' },
    });
    expect(reopened.get('theme')).toBe('dark');
  });
});
