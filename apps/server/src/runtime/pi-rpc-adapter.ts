import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { RuntimeDescriptorSchema, type RuntimeDescriptor } from '@ev/contracts';
import path from 'node:path';
import { launchEnvironment, resolveExecutable } from './executable';
import { probePi } from '../auth-probe';
import { PiRpcSession } from './pi-rpc-session';
import type {
  AgentRuntimeAdapter,
  RuntimeSession,
  RuntimeSessionInput,
  RuntimeSessionRecord,
} from './runtime-adapter';

const execFileAsync = promisify(execFile);

export class PiRpcAdapter implements AgentRuntimeAdapter {
  readonly id = 'pi' as const;

  constructor(
    private readonly options: {
      skillPaths?: string[];
      environment?: NodeJS.ProcessEnv;
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
      id: 'pi',
      name: 'Pi',
      glyph: 'π',
      availability: executable ? 'available' : 'missing',
      ...(version ? { version } : {}),
      ...(executable ? {} : { message: 'CLI not detected on PATH' }),
      auth: probePi(),
      capabilities: {
        models: true,
        thinkingLevels: true,
        tools: true,
        resumeSession: true,
        structuredEvents: true,
        permissionModes: false,
        imageInput: true,
        promptQueue: true,
      },
    });
  }

  async listSessions(): Promise<RuntimeSessionRecord[]> {
    const sessions = await SessionManager.listAll();
    return sessions.map(session => ({
      ref: { runtimeId: 'pi', nativeId: session.id, sessionFile: session.path },
      title: (
        session.name ||
        session.firstMessage ||
        path.basename(session.cwd) ||
        'Pi Session'
      ).slice(0, 200),
      cwd: session.cwd,
      createdAt: session.created.getTime(),
      updatedAt: session.modified.getTime(),
      messageCount: session.messageCount,
    }));
  }

  async createSession(input: RuntimeSessionInput): Promise<RuntimeSession> {
    const executable = await this.requireExecutable();
    return PiRpcSession.create(
      executable,
      { ...input, environment: await this.environment(input) },
      {
        skillPaths: this.options.skillPaths,
      }
    );
  }

  async resumeSession(
    input: RuntimeSessionInput & { session: NonNullable<RuntimeSessionInput['session']> }
  ): Promise<RuntimeSession> {
    if (input.session.runtimeId !== 'pi' || !input.session.sessionFile) {
      throw new Error('Pi session requires its native JSONL file');
    }
    const executable = await this.requireExecutable();
    return PiRpcSession.create(
      executable,
      { ...input, environment: await this.environment(input) },
      {
        skillPaths: this.options.skillPaths,
      }
    );
  }

  private async environment(
    input: Pick<RuntimeSessionInput, 'environment'> = {}
  ): Promise<NodeJS.ProcessEnv> {
    return launchEnvironment({
      ...process.env,
      ...this.options.environment,
      ...input.environment,
    });
  }

  private executable(): Promise<string | null> {
    return resolveExecutable('pi', 'EV_PI_CLI', this.options.environment ?? process.env);
  }

  private async requireExecutable(): Promise<string> {
    const executable = await this.executable();
    if (!executable) throw new Error('Pi CLI is not installed or unavailable on PATH');
    return executable;
  }
}
