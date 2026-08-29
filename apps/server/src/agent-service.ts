import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { getAgentDir, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { RuntimeId } from '@ev/contracts';
import type {
  CommandInfo,
  PromptImage,
  TaskDetail,
  TaskInspection,
  TaskSummary,
  ThinkingLevel,
  TraceEvent,
} from '@ev/contracts/domain';
import { RuntimeSessionUnavailableError } from './runtime/runtime-adapter';
import type { RuntimeRegistry } from './runtime/runtime-registry';
import Store from './store';
import {
  assertWorkspaceDirectory,
  sameSession,
  sessionKey,
  TaskSession,
  WorkspaceUnavailableError,
  type OwnerIndex,
  type TaskPersistence,
} from './task-session';

type PersistedTask = Omit<TaskSummary, 'status' | 'error'>;

interface StoreSchema {
  defaultWorkspace: string | null;
  defaultRuntime: RuntimeId;
  tasks: PersistedTask[];
  traces: Record<string, TraceEvent[]>;
  hiddenSessions: string[];
}

type TaskListener = (task: TaskDetail) => void;

const EV_IDENTITY = [
  'You are EV (Enhanced Vigilance), a personal, local-first desktop agent.',
  'Be direct, transparent about limitations and errors, and never claim access or capabilities',
  'you do not have.',
].join(' ');

/**
 * Task registry: records, defaults, native-session discovery, catalog refresh
 * and WS fan-out. Per-Task behavior (session, projections, state-machine,
 * persistence of its own state) lives in the deep TaskSession module; the
 * cross-task OwnerIndex data is held here and injected.
 */
export class AgentService {
  readonly modelRuntime: ModelRuntime;
  readonly store: Store<StoreSchema>;

  private readonly sessions = new Map<string, TaskSession>();
  private readonly tasks = new Map<string, TaskSummary>();
  private readonly ownedTaskIds = new Set<string>();
  private readonly sessionOwners = new Map<string, string>();
  private listener?: TaskListener;

  private readonly persistence: TaskPersistence = {
    // the store is a KV blob of the owned list, so a per-task save rewrites the list.
    saveTask: () => this.persistTasks(),
    saveTrace: (taskId, trace) => {
      const traces = this.store.get('traces');
      traces[taskId] = trace;
      this.store.set('traces', traces);
    },
    loadTrace: taskId => this.store.get('traces')[taskId] ?? [],
  };

  private readonly ownerIndex: OwnerIndex = {
    owner: key => this.sessionOwners.get(key),
    acquire: (key, taskId) => {
      this.sessionOwners.set(key, taskId);
    },
    release: (key, taskId) => {
      if (this.sessionOwners.get(key) === taskId) this.sessionOwners.delete(key);
    },
    releaseAll: taskId => {
      for (const [key, owner] of this.sessionOwners) {
        if (owner === taskId) this.sessionOwners.delete(key);
      }
    },
  };

  private constructor(
    modelRuntime: ModelRuntime,
    store: Store<StoreSchema>,
    private readonly runtimes: RuntimeRegistry,
    private readonly bundledSkillPaths: string[]
  ) {
    this.modelRuntime = modelRuntime;
    this.store = store;

    for (const persisted of store.get('tasks')) {
      // strip legacy Agent Project fields so zombie keys never get rewritten into new task data.
      const {
        agentId: _agentId,
        agentName: _agentName,
        ...rest
      } = persisted as PersistedTask & {
        agentId?: string;
        agentName?: string;
      };
      const task: TaskSummary = {
        ...rest,
        runtime:
          persisted.runtime ??
          (persisted.sessionFile
            ? {
                runtimeId: 'pi',
                nativeId: persisted.sessionFile,
                sessionFile: persisted.sessionFile,
              }
            : undefined),
        status: 'idle',
      };
      this.tasks.set(task.id, task);
      this.ownedTaskIds.add(task.id);
    }
  }

  static async create(
    runtimes: RuntimeRegistry,
    options: {
      defaultWorkspace: string;
      legacyDefaultWorkspaces?: string[];
      bundledSkillPaths?: string[];
    }
  ): Promise<AgentService> {
    const { defaultWorkspace, legacyDefaultWorkspaces = [], bundledSkillPaths = [] } = options;
    const modelRuntime = await ModelRuntime.create();
    const store = new Store<StoreSchema>({
      name: 'agent-desktop',
      defaults: {
        defaultWorkspace,
        defaultRuntime: 'pi',
        tasks: [],
        traces: {},
        hiddenSessions: [],
      },
    });
    const configuredWorkspace = store.get('defaultWorkspace');
    try {
      if (
        !configuredWorkspace ||
        legacyDefaultWorkspaces.includes(configuredWorkspace) ||
        !(await stat(configuredWorkspace)).isDirectory()
      ) {
        store.set('defaultWorkspace', defaultWorkspace);
      }
    } catch {
      store.set('defaultWorkspace', defaultWorkspace);
    }
    const service = new AgentService(modelRuntime, store, runtimes, bundledSkillPaths);
    await service.refreshCatalogs();
    return service;
  }

  setListener(listener: TaskListener): void {
    this.listener = listener;
  }

  listTasks(): TaskSummary[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listRuntimes() {
    return this.runtimes.describeAll();
  }

  getDefaultWorkspace(): string | null {
    return this.store.get('defaultWorkspace');
  }

  setDefaultWorkspace(path: string): void {
    this.store.set('defaultWorkspace', path);
  }

  getDefaultRuntime(): RuntimeId {
    return this.store.get('defaultRuntime');
  }

  setDefaultRuntime(runtimeId: RuntimeId): void {
    this.runtimes.require(runtimeId);
    this.store.set('defaultRuntime', runtimeId);
  }

  async refreshCatalogs(): Promise<void> {
    const hidden = new Set(this.store.get('hiddenSessions'));
    const descriptors = await this.runtimes.describeAll();
    for (const descriptor of descriptors) {
      if (descriptor.availability !== 'available') continue;
      const adapter = this.runtimes.require(descriptor.id);
      const records = await adapter.listSessions().catch(() => []);
      for (const record of records) {
        const key = sessionKey(record.ref);
        if (hidden.has(key)) continue;
        const existing = [...this.tasks.values()].find(task =>
          sameSession(task.runtime, record.ref)
        );
        if (existing) {
          existing.runtime = record.ref;
          existing.sessionFile = record.ref.sessionFile;
          existing.cwd = record.cwd;
          existing.updatedAt = Math.max(existing.updatedAt, record.updatedAt);
          if (!this.ownedTaskIds.has(existing.id)) existing.title = record.title;
          continue;
        }
        const id = `${record.ref.runtimeId}:${record.ref.nativeId}`;
        this.tasks.set(id, {
          id,
          title: record.title,
          cwd: record.cwd,
          sessionFile: record.ref.sessionFile,
          runtime: record.ref,
          status: 'idle',
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          model: record.model,
          thinkingLevel: record.thinkingLevel ?? 'medium',
        });
      }
    }
    this.persistTasks();
  }

  async getTask(id: string): Promise<TaskDetail> {
    const task = this.requireTask(id);
    const session = this.sessionFor(task);
    try {
      await session.ensure();
      return session.getState();
    } catch (error) {
      if (
        !(error instanceof WorkspaceUnavailableError) &&
        !(error instanceof RuntimeSessionUnavailableError)
      ) {
        throw error;
      }
      task.status = 'error';
      task.error = error.message;
      return { ...task, messages: [], trace: this.store.get('traces')[task.id] ?? [] };
    }
  }

  async createTask(cwd?: string, requestedRuntime?: RuntimeId): Promise<TaskDetail> {
    const workspace = cwd ?? this.store.get('defaultWorkspace');
    if (!workspace) throw new Error('Choose a default directory first');
    await assertWorkspaceDirectory(workspace);

    const runtimeId = requestedRuntime ?? this.store.get('defaultRuntime');
    const settings = SettingsManager.create(workspace, getAgentDir(), { projectTrusted: true });
    const defaultProvider = settings.getDefaultProvider();
    const defaultModelId = settings.getDefaultModel();
    // the native default may have gone stale (getModel throws after auth/dir changes): fall back and let pi pick its own default.
    let defaultModel: ReturnType<typeof this.modelRuntime.getModel> | undefined;
    if (runtimeId === 'pi' && defaultProvider && defaultModelId) {
      try {
        defaultModel = this.modelRuntime.getModel(defaultProvider, defaultModelId);
      } catch {
        defaultModel = undefined;
      }
    }
    const now = Date.now();
    const task: TaskSummary = {
      id: randomUUID(),
      title: 'New task',
      cwd: workspace,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      thinkingLevel: (settings.getDefaultThinkingLevel() ?? 'medium') as ThinkingLevel,
      model: defaultModel
        ? { provider: defaultModel.provider, id: defaultModel.id, name: defaultModel.name }
        : undefined,
      // requested/default engine rides in pendingRuntimeId; initialize consumes it.
      pendingRuntimeId: runtimeId,
    };
    this.tasks.set(task.id, task);
    this.ownedTaskIds.add(task.id);
    this.persistTasks();

    const session = this.sessionFor(task);
    await session.ensure();
    const detail = session.getState();
    this.listener?.(detail);
    return detail;
  }

  async removeTask(id: string): Promise<void> {
    const task = this.requireTask(id);
    await this.sessionFor(task).release();
    this.sessions.delete(id);
    this.tasks.delete(id);
    this.ownedTaskIds.delete(id);
    if (task.runtime) {
      const hidden = new Set(this.store.get('hiddenSessions'));
      hidden.add(sessionKey(task.runtime));
      this.store.set('hiddenSessions', [...hidden]);
    }
    const traces = this.store.get('traces');
    delete traces[id];
    this.store.set('traces', traces);
    this.persistTasks();
  }

  async prompt(
    id: string,
    prompt: string,
    images?: PromptImage[],
    queue?: 'steer' | 'followUp'
  ): Promise<void> {
    await this.sessionFor(this.requireTask(id)).prompt(
      prompt,
      images === undefined ? [] : images,
      queue === undefined ? 'steer' : queue
    );
  }

  async commands(id: string): Promise<CommandInfo[]> {
    return await this.sessionFor(this.requireTask(id)).commands();
  }

  async abort(id: string): Promise<void> {
    await this.sessionFor(this.requireTask(id)).abort();
  }

  async setModel(id: string, provider: string, modelId: string): Promise<void> {
    await this.sessionFor(this.requireTask(id)).setModel(provider, modelId);
  }

  async setRuntime(id: string, runtimeId: RuntimeId): Promise<void> {
    await this.sessionFor(this.requireTask(id)).switchRuntime(runtimeId);
  }

  async setThinkingLevel(id: string, level: ThinkingLevel): Promise<void> {
    await this.sessionFor(this.requireTask(id)).setThinkingLevel(level);
  }

  async inspect(id: string): Promise<TaskInspection> {
    return await this.sessionFor(this.requireTask(id)).inspect();
  }

  async dispose(): Promise<void> {
    const releaseResults = await Promise.allSettled(
      [...this.sessions.values()].map(session => session.release())
    );
    this.sessions.clear();
    const failures = releaseResults.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Unable to release every Task session');
    }
  }

  private sessionFor(task: TaskSummary): TaskSession {
    let session = this.sessions.get(task.id);
    if (!session) {
      session = new TaskSession(
        task,
        {
          registry: this.runtimes,
          ownerIndex: this.ownerIndex,
          persistence: this.persistence,
          bundledSkillPaths: this.bundledSkillPaths,
          systemPrompts: [EV_IDENTITY],
        },
        this.ownedTaskIds.has(task.id)
      );
      // the registry fans out to the WS broadcast; TaskSession itself knows no WS.
      session.subscribe(detail => this.listener?.(detail));
      this.sessions.set(task.id, session);
    }
    return session;
  }

  private requireTask(id: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Task not found');
    return task;
  }

  private persistTasks(): void {
    const tasks: PersistedTask[] = this.listTasks()
      .filter(task => this.ownedTaskIds.has(task.id))
      .map(({ status: _status, error: _error, ...task }) => task);
    this.store.set('tasks', tasks);
  }
}
