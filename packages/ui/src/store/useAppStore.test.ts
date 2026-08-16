import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDesktopAPI, AppSettings, TaskSummary } from '../shared/types';
import { useAppStore } from './useAppStore';

const workspace = process.cwd();
const persistedSettings: AppSettings = {
  defaultWorkspace: workspace,
  defaultThinkingLevel: 'medium',
  defaultRuntime: 'pi',
  theme: 'system',
};

const staleTask: TaskSummary = {
  id: 'stale-task',
  title: '不可用工作空间任务',
  cwd: `${workspace}/path-that-does-not-exist`,
  status: 'idle',
  createdAt: 1,
  updatedAt: 2,
  thinkingLevel: 'medium',
};

function installApi(api: Partial<AgentDesktopAPI>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { agentDesktop: api },
  });
}

describe('app initialization', () => {
  beforeEach(() => {
    useAppStore.setState({
      tasks: [],
      runtimes: [],
      selectedRuntimeId: 'pi',
      selectedId: null,
      detail: null,
      providers: [],
      settings: null,
      settingsOpen: false,
      loading: true,
      error: null,
    });
  });

  it('keeps settings usable when a persisted task workspace is missing', async () => {
    installApi({
      settings: { get: vi.fn().mockResolvedValue(persistedSettings) },
      enableTaskSync: vi.fn(),
      taskList: vi.fn().mockResolvedValue([staleTask]),
      subscribeTaskList: vi.fn().mockReturnValue(() => undefined),
      onResynced: vi.fn().mockReturnValue(() => undefined),
      tasks: {
        list: vi.fn().mockResolvedValue([staleTask]),
        get: vi.fn().mockRejectedValue(new Error('ENOENT: workspace missing')),
        onUpdate: vi.fn().mockReturnValue(() => undefined),
      },
      providers: { list: vi.fn().mockResolvedValue([]) },
      runtimes: { list: vi.fn().mockResolvedValue([]) },
    } as unknown as AgentDesktopAPI);

    const cleanup = await useAppStore.getState().initialize();
    const state = useAppStore.getState();

    expect(state.settings).toEqual(persistedSettings);
    expect(state.providers).toEqual([]);
    expect(state.tasks).toEqual([staleTask]);
    expect(state.detail).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.error).toContain('ENOENT');
    cleanup();
  });
});
