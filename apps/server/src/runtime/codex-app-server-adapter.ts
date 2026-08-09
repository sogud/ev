import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { RuntimeDescriptorSchema, type RuntimeDescriptor } from '@ev/contracts';
import { CodexAppServerClient } from './codex-app-server-client';
import { CodexAppServerSession } from './codex-app-server-session';
import { launchEnvironment, resolveExecutable } from './executable';
import { probeCodex } from '../auth-probe';
import type {
  AgentRuntimeAdapter,
  RuntimeSession,
  RuntimeSessionInput,
  RuntimeSessionRecord,
} from './runtime-adapter';

const execFileAsync = promisify(execFile);
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

export class CodexAppServerAdapter implements AgentRuntimeAdapter {
  readonly id = 'codex' as const;
  private client: CodexAppServerClient | null = null;
  private clientInitialization: Promise<CodexAppServerClient> | null = null;

  constructor(
    private readonly options: {
      environment?: NodeJS.ProcessEnv;
      cwd?: string;
    } = {}
  ) {}

  async describe(): Promise<RuntimeDescriptor> {
    const executable = await this.executable();
    let version: string | undefined;
    if (executable) {
      try {
        version = (
          await execFileAsync(executable, ['--version'], {
            timeout: 5_000,
            env: await this.environment(),
          })
        ).stdout.trim();
      } catch {
        version = undefined;
      }
    }
    return RuntimeDescriptorSchema.parse({
      id: 'codex',
      name: 'Codex CLI',
      glyph: 'Cx',
      availability: executable ? 'available' : 'missing',
      ...(version ? { version } : {}),
      ...(executable ? {} : { message: 'CLI not detected on PATH' }),
      // P2 全映射：模型/思考都可切。候选表为 Codex 原生 catalog 的常用静态子集
      // （app-server 未暴露 model/list 前的快照，2026-08-08）。
      auth: probeCodex(),
      modelCatalog: [
        { id: 'gpt-5.4', name: 'GPT-5.4' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
        { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' },
        { id: 'gpt-5.5', name: 'GPT-5.5' },
        { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      ],
      capabilities: {
        models: true,
        thinkingLevels: true,
        tools: true,
        resumeSession: true,
        structuredEvents: true,
        permissionModes: true,
      },
    });
  }

  async listSessions(): Promise<RuntimeSessionRecord[]> {
    const client = await this.requireClient();
    const records: RuntimeSessionRecord[] = [];
    let cursor: string | null = null;
    do {
      const result = await client.request('thread/list', {
        cursor,
        limit: 100,
        archived: false,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      });
      if (!isRecord(result) || !Array.isArray(result.data)) {
        throw new Error('Codex thread/list returned an invalid page');
      }
      for (const thread of result.data) {
        if (!isRecord(thread) || typeof thread.id !== 'string' || typeof thread.cwd !== 'string') {
          continue;
        }
        const sessionFile = typeof thread.path === 'string' ? thread.path : undefined;
        records.push({
          ref: {
            runtimeId: 'codex',
            nativeId: thread.id,
            ...(sessionFile ? { sessionFile } : {}),
          },
          title: String(
            (typeof thread.name === 'string' && thread.name) ||
              (typeof thread.preview === 'string' && thread.preview) ||
              'Codex Session'
          ).slice(0, 200),
          cwd: thread.cwd,
          createdAt: typeof thread.createdAt === 'number' ? thread.createdAt * 1000 : Date.now(),
          updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt * 1000 : Date.now(),
          messageCount: 0,
        });
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null;
    } while (cursor);
    return records;
  }

  async createSession(input: RuntimeSessionInput): Promise<RuntimeSession> {
    const client = await this.requireClient();
    const result = await client.request('thread/start', {
      cwd: input.cwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      ephemeral: false,
      ...(input.model ? { model: input.model.id } : {}),
      ...(input.appendSystemPrompts?.length
        ? { developerInstructions: input.appendSystemPrompts.join('\n\n') }
        : {}),
    });
    return this.sessionFrom(client, result, input);
  }

  async resumeSession(
    input: RuntimeSessionInput & { session: NonNullable<RuntimeSessionInput['session']> }
  ): Promise<RuntimeSession> {
    if (input.session.runtimeId !== 'codex') throw new Error('Expected a Codex session ref');
    const client = await this.requireClient();
    const result = await client.request('thread/resume', {
      threadId: input.session.nativeId,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      ...(input.model ? { model: input.model.id } : {}),
      ...(input.appendSystemPrompts?.length
        ? { developerInstructions: input.appendSystemPrompts.join('\n\n') }
        : {}),
    });
    return this.sessionFrom(client, result, input);
  }

  async dispose(): Promise<void> {
    const client =
      this.client ?? (await this.clientInitialization?.catch(() => undefined)) ?? undefined;
    this.client = null;
    this.clientInitialization = null;
    await client?.stop();
  }

  private sessionFrom(
    client: CodexAppServerClient,
    result: unknown,
    input: RuntimeSessionInput
  ): RuntimeSession {
    if (!isRecord(result) || !isRecord(result.thread)) {
      throw new Error('Codex app-server returned an invalid thread');
    }
    return new CodexAppServerSession(client, result.thread, {
      model: typeof result.model === 'string' ? result.model : input.model?.id,
      modelProvider:
        typeof result.modelProvider === 'string' ? result.modelProvider : input.model?.provider,
      thinkingLevel: input.thinkingLevel,
    });
  }

  private async requireClient(): Promise<CodexAppServerClient> {
    if (this.client) {
      await this.client.start();
      return this.client;
    }
    if (this.clientInitialization) return this.clientInitialization;
    const initialization = this.initializeClient().finally(() => {
      if (this.clientInitialization === initialization) this.clientInitialization = null;
    });
    this.clientInitialization = initialization;
    return initialization;
  }

  private async initializeClient(): Promise<CodexAppServerClient> {
    const executable = await this.executable();
    if (!executable) throw new Error('Codex CLI is not installed or unavailable on PATH');
    const client = new CodexAppServerClient({
      executable,
      cwd: this.options.cwd ?? os.homedir(),
      environment: await this.environment(),
    });
    try {
      await client.start();
      this.client = client;
      return client;
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw error;
    }
  }

  private async environment(): Promise<NodeJS.ProcessEnv> {
    return launchEnvironment({ ...process.env, ...this.options.environment });
  }

  private executable(): Promise<string | null> {
    return resolveExecutable('codex', 'EV_CODEX_CLI', this.options.environment ?? process.env);
  }
}
