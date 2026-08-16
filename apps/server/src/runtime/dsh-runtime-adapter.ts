import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeDescriptorSchema, type RuntimeDescriptor } from '@ev/contracts';
import { DshRuntimeSession, type DshRuntimeLaunch } from './dsh-runtime-session';
import {
  RuntimeSessionUnavailableError,
  type AgentRuntimeAdapter,
  type RuntimeSession,
  type RuntimeSessionInput,
} from './runtime-adapter';

export const DSH_COLD_RESUME_UNSUPPORTED =
  'DeepSeek Harness SDK does not support cold session resume';

interface DshRuntimeAdapterOptions {
  environment?: NodeJS.ProcessEnv;
}

export class DshRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = 'dsh' as const;

  constructor(private readonly options: DshRuntimeAdapterOptions = {}) {}

  async describe(): Promise<RuntimeDescriptor> {
    const launch = await this.resolveLaunchSpec();
    const apiKey = this.environment().DEEPSEEK_API_KEY?.trim();
    return RuntimeDescriptorSchema.parse({
      id: this.id,
      name: 'DeepSeek Harness',
      glyph: 'DS',
      availability: launch ? 'available' : 'missing',
      message: launch
        ? 'Experimental runtime; cold session resume is unavailable'
        : 'Set EV_DSH_RUNTIME and EV_DSH_CONFIG to readable absolute paths',
      auth: {
        status: apiKey ? 'logged_in' : 'logged_out',
        hint: apiKey
          ? 'Uses DEEPSEEK_API_KEY from the DSH process environment'
          : 'Set DEEPSEEK_API_KEY before starting EV',
      },
      capabilities: {
        models: false,
        thinkingLevels: false,
        tools: true,
        resumeSession: false,
        structuredEvents: true,
        permissionModes: false,
      },
    });
  }

  async listSessions() {
    return [];
  }

  async createSession(input: RuntimeSessionInput): Promise<RuntimeSession> {
    const environment = {
      ...(input.environment ?? process.env),
      ...this.options.environment,
    };
    const launch = await this.resolveLaunchSpec(environment);
    if (!launch) {
      throw new Error('Set EV_DSH_RUNTIME and EV_DSH_CONFIG to readable absolute paths');
    }
    return DshRuntimeSession.create(launch, input);
  }

  async resumeSession(
    input: RuntimeSessionInput & { session: NonNullable<RuntimeSessionInput['session']> }
  ): Promise<RuntimeSession> {
    if (input.session.runtimeId !== this.id) {
      throw new Error('Expected a DeepSeek Harness session ref');
    }
    throw new RuntimeSessionUnavailableError(DSH_COLD_RESUME_UNSUPPORTED);
  }

  private async resolveLaunchSpec(
    environment: NodeJS.ProcessEnv = this.environment()
  ): Promise<DshRuntimeLaunch | null> {
    const executable = environment.EV_DSH_RUNTIME?.trim();
    const configuredPath = environment.EV_DSH_CONFIG?.trim();
    if (
      !executable ||
      !configuredPath ||
      !path.isAbsolute(executable) ||
      !path.isAbsolute(configuredPath)
    ) {
      return null;
    }
    try {
      const [executableInfo, configInfo] = await Promise.all([
        stat(executable),
        stat(configuredPath),
      ]);
      if (!executableInfo.isFile() || !configInfo.isFile()) return null;
      await Promise.all([
        access(executable, constants.X_OK),
        access(configuredPath, constants.R_OK),
      ]);
      return { executable, configPath: configuredPath, environment };
    } catch {
      return null;
    }
  }

  private environment(): NodeJS.ProcessEnv {
    return this.options.environment ?? process.env;
  }
}
