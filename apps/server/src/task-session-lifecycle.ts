import { stat } from 'node:fs/promises';
import type { RuntimeEvent, RuntimeId, RuntimeSessionRef } from '@ev/contracts';
import type { TaskSummary, TraceEvent, TranscriptItem } from '@ev/contracts/domain';
import { launchEnvironment } from './runtime/executable';
import type { RuntimeSession, RuntimeSessionInput } from './runtime/runtime-adapter';
import type { RuntimeRegistry } from './runtime/runtime-registry';

/** Task 工作空间缺失/非法；getTask 用它把任务标为不可用而不阻断启动。 */
export class WorkspaceUnavailableError extends Error {}

export interface TaskRuntime {
  session: RuntimeSession;
  transcript: Map<string, TranscriptItem>;
  trace: Map<string, TraceEvent>;
  activeRunId?: string;
  unsubscribe: () => void;
}

export function sessionKey(ref: RuntimeSessionRef): string {
  return `${ref.runtimeId}:${ref.nativeId}`;
}

export function sameSession(
  left: RuntimeSessionRef | undefined,
  right: RuntimeSessionRef
): boolean {
  if (!left) return false;
  return (
    (left.runtimeId === right.runtimeId && left.nativeId === right.nativeId) ||
    Boolean(left.sessionFile && right.sessionFile && left.sessionFile === right.sessionFile)
  );
}

/**
 * 投影钩子：映射/持久化/广播都不归生命周期管，经这组回调留在 AgentService，
 * 使本模块只持有并发不变量，测试无需 mock 任何外部依赖。
 */
export interface TaskSessionHooks {
  onEvent(task: TaskSummary, runtime: TaskRuntime, event: RuntimeEvent): void;
  messageFrom(event: Extract<RuntimeEvent, { type: 'message' }>): TranscriptItem;
  loadTrace(taskId: string): TraceEvent[];
  ownsMetadata(taskId: string): boolean;
}

/**
 * Task 会话生命周期：Task 绑定 RuntimeSession 的创建/续跑/替换/释放与所有权仲裁。
 * 不变量——首条消息前可换引擎（丢弃未起跑会话重建），首条消息或首 turn running 后锁定；
 * 同一原生会话不能被两个 Task 占用（sessionOwners）。
 * 不持久化、不广播：task 记录的 session ref 由本模块改写，落盘与 emit 归调用方。
 */
export class TaskSessionLifecycle {
  private readonly active = new Map<string, TaskRuntime>();
  private readonly initializing = new Map<string, Promise<TaskRuntime>>();
  private readonly runtimeSwitches = new Map<string, Promise<void>>();
  private readonly sessionOwners = new Map<string, string>();

  constructor(
    private readonly runtimes: RuntimeRegistry,
    private readonly bundledSkillPaths: string[],
    private readonly systemPrompts: string[],
    private readonly hooks: TaskSessionHooks
  ) {}

  get(id: string): TaskRuntime | undefined {
    return this.active.get(id);
  }

  ensure(task: TaskSummary, suppliedRuntime?: RuntimeId): Promise<TaskRuntime> {
    const current = this.active.get(task.id);
    if (current) return Promise.resolve(current);
    const pending = this.initializing.get(task.id);
    if (pending) return pending;
    const initialization = this.initialize(task, suppliedRuntime).finally(() =>
      this.initializing.delete(task.id)
    );
    this.initializing.set(task.id, initialization);
    return initialization;
  }

  /**
   * 首条消息前允许切换 runtime；重叠点击按任务串行化，防 double dispose / double init。
   * 锁定（transcript 非空或首 turn running）时 throw「对话已开始，Runtime 已锁定」。
   */
  async switchRuntime(task: TaskSummary, runtimeId: RuntimeId): Promise<void> {
    const previous = this.runtimeSwitches.get(task.id) ?? Promise.resolve();
    const wrapped: Promise<void> = previous
      .catch(() => undefined)
      .then(() => this.switchOnce(task, runtimeId))
      .finally(() => {
        if (this.runtimeSwitches.get(task.id) === wrapped) this.runtimeSwitches.delete(task.id);
      });
    this.runtimeSwitches.set(task.id, wrapped);
    await wrapped;
  }

  /**
   * 首消息前改 model/thinkingLevel：更新任务记录并丢弃已建会话（延迟按新配置重建）。
   * 非 pi runtime 不支持会话内热改，统一走「换配置=重建」语义。
   */
  async reconfigure(
    task: TaskSummary,
    patch: { model?: TaskSummary['model']; thinkingLevel?: TaskSummary['thinkingLevel'] }
  ): Promise<void> {
    const pending = this.initializing.get(task.id);
    if (pending) await pending.catch(() => undefined);
    const current = this.active.get(task.id);
    if (current && (current.transcript.size > 0 || task.status === 'running')) {
      throw new Error('对话已开始，配置已锁定');
    }
    if (patch.model !== undefined) task.model = patch.model;
    if (patch.thinkingLevel !== undefined) task.thinkingLevel = patch.thinkingLevel;
    this.active.delete(task.id);
    if (task.runtime) this.sessionOwners.delete(sessionKey(task.runtime));
    task.runtime = undefined;
    task.sessionFile = undefined;
    if (current) {
      current.unsubscribe();
      await current.session.dispose();
    }
  }

  /** 当前生效/目标 runtime（pendingRuntimeId 优先），UI 与 setModel 路由用。 */
  peekRuntimeId(task: TaskSummary): RuntimeId {
    return task.pendingRuntimeId ?? task.runtime?.runtimeId ?? 'pi';
  }

  /** removeTask 用：dispose 并释放该任务的全部所有权记录。 */
  async release(id: string): Promise<void> {
    const runtime =
      this.active.get(id) ?? (await this.initializing.get(id)?.catch(() => undefined));
    runtime?.unsubscribe();
    await runtime?.session.dispose();
    this.active.delete(id);
    this.initializing.delete(id);
    for (const [key, owner] of this.sessionOwners) {
      if (owner === id) this.sessionOwners.delete(key);
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled(this.initializing.values());
    for (const runtime of this.active.values()) {
      runtime.unsubscribe();
      await runtime.session.dispose();
    }
    this.active.clear();
    this.initializing.clear();
    this.sessionOwners.clear();
  }

  private async switchOnce(task: TaskSummary, runtimeId: RuntimeId): Promise<void> {
    // 等待 in-flight 的 initialize 结束，避免它在 dispose 之后回写 active，
    // 造成旧 runtime 泄漏 + 锁检查读到过期状态。
    const pending = this.initializing.get(task.id);
    if (pending) await pending.catch(() => undefined);
    const current = this.active.get(task.id);
    if (current && (current.transcript.size > 0 || task.status === 'running')) {
      throw new Error('对话已开始，Runtime 已锁定');
    }
    // 先摘 active、清 ref、释放 owner，再 dispose：dispose 窗口内的并发 ensure
    // 会走 createSession，不会 resume 将死会话；无 current 时同样要清 ref，
    // 否则懒任务会拿旧 runtime 的旧 ref 走 resumeSession。
    this.active.delete(task.id);
    if (task.runtime) this.sessionOwners.delete(sessionKey(task.runtime));
    task.runtime = undefined;
    task.sessionFile = undefined;
    // 目标记入 pendingRuntimeId（持久化字段）：renderer 即时显示、重启仍生效，
    // 会话延迟到首次 ensure 建：切换本身只付 dispose 成本。
    task.pendingRuntimeId = runtimeId;
    // 跨 runtime 切换不携带旧模型：非 pi 模型须从目标 catalog 显式选（避免把
    // gpt-5.4 喂给 qoder 这类跨词表错误）。
    if (runtimeId !== 'pi') task.model = undefined;
    if (current) {
      current.unsubscribe();
      await current.session.dispose();
    }
    task.updatedAt = Date.now();
  }

  private async initialize(task: TaskSummary, suppliedRuntime?: RuntimeId): Promise<TaskRuntime> {
    await assertWorkspaceDirectory(task.cwd);
    const pending = task.pendingRuntimeId;
    const runtimeId = suppliedRuntime ?? pending ?? task.runtime?.runtimeId ?? 'pi';
    const adapter = this.runtimes.require(runtimeId);
    const requestedSessionKey = task.runtime ? sessionKey(task.runtime) : undefined;
    if (requestedSessionKey) {
      const owner = this.sessionOwners.get(requestedSessionKey);
      if (owner && owner !== task.id) throw new Error('该原生会话已在另一个 EV 任务中打开');
      this.sessionOwners.set(requestedSessionKey, task.id);
    }
    const input = await this.runtimeInput(task);
    let session: RuntimeSession;
    try {
      session = task.runtime
        ? await adapter.resumeSession({ ...input, session: task.runtime })
        : await adapter.createSession(input);
    } catch (error) {
      if (requestedSessionKey && this.sessionOwners.get(requestedSessionKey) === task.id) {
        this.sessionOwners.delete(requestedSessionKey);
      }
      throw error;
    }
    const state = session.getState();
    const nativeSessionKey = sessionKey(state.ref);
    const nativeOwner = this.sessionOwners.get(nativeSessionKey);
    if (nativeOwner && nativeOwner !== task.id) {
      await session.dispose();
      throw new Error('该原生会话已在另一个 EV 任务中打开');
    }
    this.sessionOwners.set(nativeSessionKey, task.id);
    task.runtime = state.ref;
    task.pendingRuntimeId = undefined;
    task.sessionFile = state.ref.sessionFile;
    task.model = state.model ?? task.model;
    task.thinkingLevel = state.thinkingLevel ?? task.thinkingLevel;

    const transcript = new Map<string, TranscriptItem>();
    for (const event of session.getEvents()) {
      if (event.type === 'message') transcript.set(event.id, this.hooks.messageFrom(event));
    }
    const runtime: TaskRuntime = {
      session,
      transcript,
      trace: new Map(this.hooks.loadTrace(task.id).map(item => [item.id, item])),
      unsubscribe: () => undefined,
    };
    runtime.unsubscribe = session.subscribe(event => this.hooks.onEvent(task, runtime, event));
    this.active.set(task.id, runtime);
    return runtime;
  }

  private async runtimeInput(task: TaskSummary): Promise<RuntimeSessionInput> {
    const ownsMetadata = this.hooks.ownsMetadata(task.id);
    return {
      cwd: task.cwd,
      name: task.title === '新任务' ? undefined : task.title,
      model: ownsMetadata ? task.model : undefined,
      thinkingLevel: ownsMetadata ? task.thinkingLevel : undefined,
      session: task.runtime,
      skillPaths: [...this.bundledSkillPaths],
      appendSystemPrompts: [...this.systemPrompts],
      // 子进程 env 唯一入口：登录 shell PATH + 兜底 + EV launcher 目录。
      environment: await launchEnvironment(),
    };
  }
}

/** Task 工作空间目录校验；createTask 与 initialize 共用，错误统一为 WorkspaceUnavailableError。 */
export async function assertWorkspaceDirectory(value: string): Promise<void> {
  try {
    const info = await stat(value);
    if (!info.isDirectory()) throw new WorkspaceUnavailableError(`工作空间不是目录：${value}`);
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new WorkspaceUnavailableError(`工作空间不存在：${value}`);
    }
    throw error;
  }
}
