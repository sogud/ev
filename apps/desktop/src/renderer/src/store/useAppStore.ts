import { create } from 'zustand';
import { i18n, langOverride } from '../i18n';
import { resolveLanguage } from '@ev/locales';
import type {
  AppSettings,
  ProviderSummary,
  RuntimeDescriptor,
  RuntimeId,
  TaskDetail,
  TaskSummary,
  ThinkingLevel,
} from '../../../shared/types';

interface AppState {
  tasks: TaskSummary[];
  runtimes: RuntimeDescriptor[];
  selectedRuntimeId: RuntimeId;
  selectedId: string | null;
  detail: TaskDetail | null;
  providers: ProviderSummary[];
  settings: AppSettings | null;
  settingsOpen: boolean;
  loading: boolean;
  error: string | null;
  initialize(): Promise<() => void>;
  selectTask(id: string): Promise<void>;
  createTask(cwd?: string): Promise<void>;
  removeTask(id: string): Promise<void>;
  sendPrompt(prompt: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, model: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  refreshProviders(): Promise<void>;
  /** Thin post-resync delegation: the client converges the task list itself; this
   * only refreshes state the client cannot know (providers/runtimes/open detail). */
  refreshAfterResync(): Promise<void>;
  setTaskRuntime(id: string, runtimeId: RuntimeId): Promise<void>;
  selectRuntime(id: RuntimeId): void;
  updateSettings(input: Partial<AppSettings>): Promise<void>;
  openSettings(open: boolean): void;
  clearError(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summaryOf(detail: TaskDetail): TaskSummary {
  const { messages: _messages, trace: _trace, ...summary } = detail;
  return summary;
}

export const useAppStore = create<AppState>((set, get) => ({
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

  initialize: async () => {
    try {
      window.agentDesktop.enableTaskSync();
      const [settings, tasks, providers, runtimes] = await Promise.all([
        window.agentDesktop.settings.get(),
        window.agentDesktop.taskList(),
        window.agentDesktop.providers.list(),
        window.agentDesktop.runtimes.list(),
      ]);
      const selectedId = tasks[0]?.id ?? null;
      if (!langOverride) void i18n.changeLanguage(resolveLanguage(settings.language));
      set({
        settings,
        tasks,
        providers,
        runtimes,
        selectedRuntimeId: settings.defaultRuntime,
        selectedId,
        detail: null,
        loading: false,
      });

      if (selectedId) {
        try {
          const detail = await window.agentDesktop.tasks.get(selectedId);
          set({ detail });
        } catch (error) {
          set({ error: messageOf(error) });
        }
      }
    } catch (error) {
      set({ error: messageOf(error), loading: false });
    }

    const offList = window.agentDesktop.subscribeTaskList(list => set({ tasks: list }));
    const offUpdate = window.agentDesktop.tasks.onUpdate(detail => {
      set(state => ({
        detail: state.selectedId === detail.id ? detail : state.detail,
      }));
    });
    return () => {
      offList();
      offUpdate();
    };
  },

  refreshAfterResync: async () => {
    try {
      const [providers, runtimes] = await Promise.all([
        window.agentDesktop.providers.list(),
        window.agentDesktop.runtimes.list(),
      ]);
      set({ providers, runtimes });
      const selectedId = get().selectedId;
      if (selectedId) {
        const detail = await window.agentDesktop.tasks.get(selectedId);
        if (get().selectedId === selectedId) set({ detail });
      }
    } catch {
      // Silent: the next reconnect or user action re-converges.
    }
  },

  selectTask: async id => {
    // Switching tasks clears stale errors so old toasts cannot mislead (P0 fallout).
    set({ selectedId: id, detail: null, error: null });
    try {
      const detail = await window.agentDesktop.tasks.get(id);
      if (get().selectedId === id) set({ detail });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  createTask: async cwd => {
    try {
      const detail = await window.agentDesktop.tasks.create(cwd, get().selectedRuntimeId);
      set(state => ({
        tasks: [summaryOf(detail), ...state.tasks.filter(task => task.id !== detail.id)],
        selectedId: detail.id,
        detail,
        error: null,
      }));
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  removeTask: async id => {
    try {
      await window.agentDesktop.tasks.remove(id);
      const tasks = get().tasks.filter(task => task.id !== id);
      const selectedId = get().selectedId === id ? (tasks[0]?.id ?? null) : get().selectedId;
      set({ tasks, selectedId, detail: null });
      if (selectedId) await get().selectTask(selectedId);
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  sendPrompt: async prompt => {
    const id = get().selectedId;
    if (!id) return;
    try {
      await window.agentDesktop.tasks.prompt(id, prompt);
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  abort: async () => {
    const id = get().selectedId;
    if (!id) return;
    try {
      await window.agentDesktop.tasks.abort(id);
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  setModel: async (provider, model) => {
    const id = get().selectedId;
    if (!id) return;
    try {
      await window.agentDesktop.tasks.setModel(id, provider, model);
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  setThinkingLevel: async level => {
    const id = get().selectedId;
    if (!id) return;
    try {
      await window.agentDesktop.tasks.setThinkingLevel(id, level);
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  refreshProviders: async () => {
    try {
      set({ providers: await window.agentDesktop.providers.list() });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  selectRuntime: selectedRuntimeId => set({ selectedRuntimeId }),
  // The main side adjudicates the locked state (throws once a conversation started);
  // catch here and surface a toast to avoid unhandled rejections.
  // On success no manual set is needed: tasks:update pushes the rebuilt detail.
  setTaskRuntime: async (id, runtimeId) => {
    try {
      await window.agentDesktop.tasks.setRuntime(id, runtimeId);
      set({ error: null });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  updateSettings: async input => {
    try {
      const settings = await window.agentDesktop.settings.update(input);
      set({
        settings,
        ...(input.defaultRuntime ? { selectedRuntimeId: input.defaultRuntime } : {}),
      });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  openSettings: settingsOpen => set({ settingsOpen }),
  clearError: () => set({ error: null }),
}));
