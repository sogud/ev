import { basename, dirname, join } from 'node:path';
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type {
  AppSettings,
  ResourceSettingsInput,
  ResourceSnapshot,
  ThinkingLevel,
} from '@ev/contracts/domain';
import type { AgentService } from './agent-service';
import type { AppearanceStore } from './appearance-store';

export class ManagementService {
  constructor(
    private readonly agents: AgentService,
    private readonly fallbackCwd: string,
    private readonly appearance: AppearanceStore
  ) {}

  async getSettings(): Promise<AppSettings> {
    const settings = this.settingsManager();
    return {
      defaultWorkspace: this.agents.getDefaultWorkspace(),
      defaultProvider: settings.getDefaultProvider(),
      defaultModel: settings.getDefaultModel(),
      defaultThinkingLevel: (settings.getDefaultThinkingLevel() ?? 'medium') as ThinkingLevel,
      defaultRuntime: this.agents.getDefaultRuntime(),
      theme: this.appearance.getTheme(),
    };
  }

  async updateSettings(input: Partial<AppSettings>): Promise<AppSettings> {
    if (input.defaultWorkspace) this.agents.setDefaultWorkspace(input.defaultWorkspace);
    if (input.defaultRuntime) this.agents.setDefaultRuntime(input.defaultRuntime);
    const settings = this.settingsManager(input.defaultWorkspace ?? undefined);

    if (input.defaultProvider && input.defaultModel) {
      settings.setDefaultModelAndProvider(input.defaultProvider, input.defaultModel);
    }
    if (input.defaultThinkingLevel) settings.setDefaultThinkingLevel(input.defaultThinkingLevel);
    if (input.theme !== undefined) {
      if (!['system', 'light', 'dark'].includes(input.theme)) throw new Error('无效的界面主题');
      // 无头 server 只记录偏好；原生窗壳主题由 desktop 客户端自行应用。
      this.appearance.setTheme(input.theme);
    }
    settings.setDefaultProjectTrust('always');
    await settings.flush();
    return this.getSettings();
  }

  async getResources(): Promise<ResourceSnapshot> {
    const settings = this.settingsManager();
    const loader = new DefaultResourceLoader({
      cwd: this.cwd(),
      agentDir: getAgentDir(),
      settingsManager: settings,
    });
    await loader.reload();

    const skillResult = loader.getSkills();
    const extensionResult = loader.getExtensions();
    return {
      skills: skillResult.skills.map(skill => ({
        name: skill.name,
        description: skill.description,
        path: skill.filePath,
        source: skill.sourceInfo.source,
      })),
      extensions: extensionResult.extensions
        .filter(extension => !extension.hidden)
        .map(extension => ({
          name: basename(extension.path),
          path: extension.resolvedPath,
          source: extension.sourceInfo.source,
        })),
      packages: settings
        .getPackages()
        .map(value => (typeof value === 'string' ? value : value.source)),
      skillPaths: settings.getSkillPaths(),
      extensionPaths: settings.getExtensionPaths(),
      diagnostics: [
        ...skillResult.diagnostics.map(item => item.message),
        ...extensionResult.errors.map(item => `${item.path}: ${item.error}`),
      ],
    };
  }

  async updateResources(input: ResourceSettingsInput): Promise<ResourceSnapshot> {
    const settings = this.settingsManager();
    settings.setPackages(input.packages.filter(Boolean));
    settings.setSkillPaths(input.skillPaths.filter(Boolean));
    settings.setExtensionPaths(input.extensionPaths.filter(Boolean));
    await settings.flush();
    return this.getResources();
  }

  private cwd(): string {
    return this.agents.getDefaultWorkspace() ?? this.fallbackCwd;
  }

  private settingsManager(cwd?: string): SettingsManager {
    return SettingsManager.create(cwd ?? this.cwd(), getAgentDir(), { projectTrusted: true });
  }
}
