import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { getAgentDir, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { RuntimeEvent, RuntimeId } from '@ev/contracts';
import Store from './store';
import type {
  TaskDetail,
  TaskInspection,
  TaskSummary,
  ThinkingLevel,
  TraceEvent,
  TranscriptItem,
} from '@ev/contracts/domain';
import type { RuntimeRegistry } from './runtime/runtime-registry';
import {
  assertWorkspaceDirectory,
  sameSession,
  sessionKey,
  TaskSessionLifecycle,
  WorkspaceUnavailableError,
  type TaskRuntime,
} from './task-session-lifecycle';
import { taskTitleFromPrompt } from './task-title';
import { inspectWorkspace } from './workspace-inspection';

interface PersistedTask extends Omit<TaskSummary, 'status' | 'error'> {}

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

export class AgentService {
  readonly modelRuntime: ModelRuntime;
  readonly store: Store<StoreSchema>;

  private readonly lifecycle: TaskSessionLifecycle;
  private readonly tasks = new Map<string, TaskSummary>();
  private readonly ownedTaskIds = new Set<string>();
  private listener?: TaskListener;

  private constructor(
    modelRuntime: ModelRuntime,
    store: Store<StoreSchema>,
    private readonly runtimes: RuntimeRegistry,
    bundledSkillPaths: string[]
  ) {
    this.modelRuntime = modelRuntime;
    this.store = store;
    // 投影/持久化/广播经 hooks 留在本类；lifecycle 只持有并发不变量。
    this.lifecycle = new TaskSessionLifecycle(runtimes, bundledSkillPaths, [EV_IDENTITY], {
      onEvent: (task, runtime, event) => this.onRuntimeEvent(task, runtime, event),
      messageFrom: event => this.transcriptFrom(event),
      loadTrace: taskId => this.store.get('traces')[taskId] ?? [],
      ownsMetadata: taskId => this.ownedTaskIds.has(taskId),
    });

    for (const persisted of store.get('tasks')) {
      // 剥离历史遗留的 Agent Project 字段，避免把僵尸字段回写进新版 task 数据。
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
    try {
      const runtime = await this.lifecycle.ensure(task);
      return this.toDetail(task, runtime);
    } catch (error) {
      if (!(error instanceof WorkspaceUnavailableError)) throw error;
      task.status = 'error';
      task.error = error.message;
      return this.toUnavailableDetail(task);
    }
  }

  async createTask(cwd?: string, requestedRuntime?: RuntimeId): Promise<TaskDetail> {
    const workspace = cwd ?? this.store.get('defaultWorkspace');
    if (!workspace) throw new Error('请先选择默认目录');
    await assertWorkspaceDirectory(workspace);

    const runtimeId = requestedRuntime ?? this.store.get('defaultRuntime');
    const settings = SettingsManager.create(workspace, getAgentDir(), { projectTrusted: true });
    const defaultProvider = settings.getDefaultProvider();
    const defaultModelId = settings.getDefaultModel();
    // 原生默认可能已失效（auth/目录变更后 getModel 抛错）：容忍回退，让 pi 自选默认。
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
      title: '新任务',
      cwd: workspace,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      thinkingLevel: (settings.getDefaultThinkingLevel() ?? 'medium') as ThinkingLevel,
      model: defaultModel
        ? { provider: defaultModel.provider, id: defaultModel.id, name: defaultModel.name }
        : undefined,
    };
    this.tasks.set(task.id, task);
    this.ownedTaskIds.add(task.id);
    this.persistTasks();

    const runtime = await this.lifecycle.ensure(task, runtimeId);
    const detail = this.toDetail(task, runtime);
    this.listener?.(detail);
    return detail;
  }

  async removeTask(id: string): Promise<void> {
    const task = this.requireTask(id);
    await this.lifecycle.release(id);
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

  async prompt(id: string, prompt: string): Promise<void> {
    await this.beginPrompt(id, prompt);
  }

  private async beginPrompt(id: string, prompt: string): Promise<void> {
    const text = prompt.trim();
    if (!text) return;
    const task = this.requireTask(id);
    const runtime = await this.lifecycle.ensure(task);

    if (task.title === '新任务') task.title = taskTitleFromPrompt(text);
    task.status = 'running';
    task.error = undefined;
    task.updatedAt = Date.now();
    this.persistTasks();
    this.emit(task, runtime);

    const run = runtime.session.promptAndWait(text).catch((error: unknown) => {
      task.status = 'error';
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = Date.now();
      this.addErrorTrace(runtime, task.error);
      this.persistTasks();
      this.persistTrace(task.id, runtime);
      this.emit(task, runtime);
    });
    void run;
  }

  async abort(id: string): Promise<void> {
    const task = this.requireTask(id);
    const runtime = await this.lifecycle.ensure(task);
    await runtime.session.abort();
    task.status = 'idle';
    task.updatedAt = Date.now();
    this.emit(task, runtime);
  }

  async setModel(id: string, provider: string, modelId: string): Promise<void> {
    const task = this.requireTask(id);
    if (this.lifecycle.peekRuntimeId(task) === 'pi') {
      const runtime = await this.lifecycle.ensure(task);
      if (!runtime.session.setModel) throw new Error('pi 不支持切换模型');
      await runtime.session.setModel(provider, modelId);
      return;
    }
    // 非 pi：首消息前「换配置=重建」（reconfigure），之后 throw 锁定。
    await this.lifecycle.reconfigure(task, { model: { provider, id: modelId, name: modelId } });
    this.persistTasks();
    this.listener?.({ ...task, messages: [], trace: [] });
  }

  /**
   * 首条消息前允许切换 runtime（composer 下方 chip 行是唯一调用入口，sidebar 纯展示）。
   * 并发不变量（串行化/锁/所有权）在 TaskSessionLifecycle；这里只落盘与广播。
   */
  async setRuntime(id: string, runtimeId: RuntimeId): Promise<void> {
    const task = this.requireTask(id);
    await this.lifecycle.switchRuntime(task, runtimeId);
    this.persistTasks();
    // 会话延迟建：切换只付 dispose 成本，广播空 transcript/trace 让 renderer 即时更新（P1）。
    this.listener?.({ ...task, messages: [], trace: [] });
  }

  async setThinkingLevel(id: string, level: ThinkingLevel): Promise<void> {
    const task = this.requireTask(id);
    if (this.lifecycle.peekRuntimeId(task) === 'pi') {
      const runtime = await this.lifecycle.ensure(task);
      if (!runtime.session.setThinkingLevel) throw new Error('pi 不支持切换思考强度');
      await runtime.session.setThinkingLevel(level);
      return;
    }
    await this.lifecycle.reconfigure(task, { thinkingLevel: level });
    this.persistTasks();
    this.listener?.({ ...task, messages: [], trace: [] });
  }

  async inspect(id: string): Promise<TaskInspection> {
    const task = this.requireTask(id);
    const runtime = await this.lifecycle.ensure(task);
    return {
      trace: [...runtime.trace.values()].sort((a, b) => a.timestamp - b.timestamp),
      changes: await inspectWorkspace(task.cwd),
    };
  }

  async dispose(): Promise<void> {
    await this.lifecycle.disposeAll();
    await this.runtimes.dispose();
  }

  private onRuntimeEvent(task: TaskSummary, runtime: TaskRuntime, event: RuntimeEvent): void {
    if (event.type === 'message') {
      runtime.transcript.set(event.id, this.transcriptFrom(event));
      if (event.role === 'tool') {
        runtime.trace.set(event.id, {
          id: event.id,
          type: 'tool',
          title: event.toolName ?? 'tool',
          detail: event.content,
          status:
            event.toolStatus === 'error'
              ? 'error'
              : event.toolStatus === 'done'
                ? 'done'
                : 'running',
          timestamp: event.timestamp,
        });
      }
    }
    if (event.type === 'status') {
      task.status = event.status;
      task.error = event.error;
      if (event.status === 'running') {
        runtime.activeRunId = `agent-run-${Date.now()}`;
        runtime.trace.set(runtime.activeRunId, {
          id: runtime.activeRunId,
          type: 'model',
          title: `${task.runtime?.runtimeId ?? 'pi'} run`,
          status: 'running',
          timestamp: Date.now(),
        });
      } else if (runtime.activeRunId) {
        const trace = runtime.trace.get(runtime.activeRunId);
        if (trace) {
          trace.status = event.status === 'error' ? 'error' : 'done';
          trace.durationMs = Date.now() - trace.timestamp;
        }
        runtime.activeRunId = undefined;
      }
    }
    if (event.type === 'session') {
      task.runtime = event.session;
      task.sessionFile = event.session.sessionFile;
      task.model = event.model ?? task.model;
      task.thinkingLevel = event.thinkingLevel ?? task.thinkingLevel;
    }
    task.updatedAt = Date.now();
    this.persistTasks();
    this.persistTrace(task.id, runtime);
    this.emit(task, runtime);
  }

  private transcriptFrom(event: Extract<RuntimeEvent, { type: 'message' }>): TranscriptItem {
    return {
      id: event.id,
      kind: event.role,
      content: event.content,
      timestamp: event.timestamp,
      toolName: event.toolName,
      toolStatus: event.toolStatus,
    };
  }

  private toDetail(task: TaskSummary, runtime: TaskRuntime): TaskDetail {
    return {
      ...task,
      messages: [...runtime.transcript.values()].sort((a, b) => a.timestamp - b.timestamp),
      trace: [...runtime.trace.values()].sort((a, b) => a.timestamp - b.timestamp),
    };
  }

  private toUnavailableDetail(task: TaskSummary): TaskDetail {
    return { ...task, messages: [], trace: this.store.get('traces')[task.id] ?? [] };
  }

  private emit(task: TaskSummary, runtime: TaskRuntime): void {
    this.listener?.(this.toDetail(task, runtime));
  }

  private requireTask(id: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new Error('任务不存在');
    return task;
  }

  private persistTasks(): void {
    const tasks: PersistedTask[] = this.listTasks()
      .filter(task => this.ownedTaskIds.has(task.id))
      .map(({ status: _status, error: _error, ...task }) => task);
    this.store.set('tasks', tasks);
  }

  private persistTrace(taskId: string, runtime: TaskRuntime): void {
    const traces = this.store.get('traces');
    traces[taskId] = [...runtime.trace.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-500);
    this.store.set('traces', traces);
  }

  private addErrorTrace(runtime: TaskRuntime, message: string): void {
    const timestamp = Date.now();
    runtime.trace.set(`error-${timestamp}`, {
      id: `error-${timestamp}`,
      type: 'error',
      title: '运行失败',
      detail: message,
      status: 'error',
      timestamp,
    });
  }
}
