import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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

  it('重启持久化：resetBackend 后重开仍在', () => {
    const store = new Store<{ tasks: number[] }>({
      name: 'agent-desktop',
      defaults: { tasks: [] },
    });
    store.set('tasks', [1, 2, 3]);
    resetBackend(); // 模拟进程重启
    const reopened = new Store<{ tasks: number[] }>({
      name: 'agent-desktop',
      defaults: { tasks: [] },
    });
    expect(reopened.get('tasks')).toEqual([1, 2, 3]);
    expect(existsSync(join(data, 'ev.db'))).toBe(true);
  });

  it('旧 JSON 迁移不丢失且幂等', () => {
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

    // 迁移后写入新值；再次 reset（模拟二次启动）不得被旧文件覆盖。
    migrated.set('tasks', [{ id: 'new-1' }]);
    resetBackend();
    const second = new Store<{ tasks: Array<{ id: string }> }>({
      name: 'agent-desktop',
      defaults: { tasks: [] },
    });
    expect(second.get('tasks')).toEqual([{ id: 'new-1' }]);
    expect(existsSync(join(data, 'migrated-to-sqlite.json'))).toBe(true);
    // 旧文件保留不删
    expect(existsSync(join(legacy, 'agent-desktop.json'))).toBe(true);
  });
});
