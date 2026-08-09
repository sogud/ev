import { execFile } from 'node:child_process';
import type { BrowserBridgeService } from '@ev/browser-host';
import type { ipcRegistry, HandlersOf } from '@ev/contracts';
import { probeClaude, probeCodex, probePi, probeQoder, type NativeAuth } from './auth-probe';
import type { AgentService } from './agent-service';
import type { ManagementService } from './management-service';

export interface ServerDeps {
  agents: AgentService;
  management: ManagementService;
  browserBridge: BrowserBridgeService;
  /** WS 广播（tasks:update / auth:* / browserBridge:update）。 */
  broadcast: (channel: string, payload: unknown) => void;
}

/**
 * ipcRegistry handlers 整体从 desktop ipc.ts 搬入（搬家不是重写）。
 * 去 Electron：chooseDirectory 无头返回 null（客户端自带路径输入）；
 * openPath/openInEditor 用系统 `open`。
 */
export function buildHandlers(deps: ServerDeps): HandlersOf<typeof ipcRegistry> {
  const { agents, management, browserBridge, broadcast } = deps;

  return {
    tasks: {
      list: () => agents.listTasks(),
      get: id => agents.getTask(id),
      create: (cwd, runtimeId) => agents.createTask(cwd, runtimeId),
      remove: id => agents.removeTask(id),
      prompt: (id, prompt) => agents.prompt(id, prompt),
      abort: id => agents.abort(id),
      setRuntime: (id, runtimeId) => agents.setRuntime(id, runtimeId),
      setModel: (id, provider, model) => agents.setModel(id, provider, model),
      setThinkingLevel: (id, level) => agents.setThinkingLevel(id, level),
    },
    runtimes: {
      list: () => agents.listRuntimes(),
    },
    inspection: {
      get: id => agents.inspect(id),
    },
    providers: {
      // 只读（native-auth-display-v1）：模型目录/认证态均从 pi ModelRuntime 原生读出，
      // EV 不持凭据、不维护模型库；supports* 仅布尔，不暴露密钥。
      list: async () => {
        const mr = agents.modelRuntime;
        const available = new Set(
          (await mr.getAvailable().catch(() => [] as Array<{ provider: string; id: string }>)).map(
            model => `${model.provider}/${model.id}`
          )
        );
        return mr.getProviders().map(provider => {
          const status = mr.getProviderAuthStatus(provider.id);
          return {
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            authStatus: status.configured ? ('configured' as const) : ('missing' as const),
            // EV 不再做 provider 认证：supports* 恒 false，也不读密钥存在性。
            supportsApiKey: false,
            supportsOAuth: false,
            custom: false,
            models: mr.getModels(provider.id).map(model => ({
              id: model.id,
              name: model.name,
              provider: model.provider,
              api: model.api,
              reasoning: model.reasoning,
              contextWindow: model.contextWindow,
              available: available.has(`${model.provider}/${model.id}`),
            })),
          };
        });
      },
    },
    resources: {
      get: () => management.getResources(),
      update: input => management.updateResources(input),
    },
    browserBridge: {
      get: () => browserBridge.getSnapshot(),
      approvePairing: () => browserBridge.approvePendingPairing(),
      rejectPairing: () => browserBridge.rejectPendingPairing(),
      reconnect: () => browserBridge.requestReconnect(),
      revokePairing: () => browserBridge.revokePairing(),
    },
    settings: {
      get: () => management.getSettings(),
      update: input => management.updateSettings(input),
      // 无头 server 没有原生目录选择对话框；客户端自行收集路径。
      chooseDirectory: async () => null,
      openPath: async path => {
        const error = await openExternal(path);
        if (error) throw new Error(error);
      },
    },
    workspace: {
      gitBranch: async cwd => {
        if (typeof cwd !== 'string' || cwd.length === 0) return null;
        return await new Promise<string | null>(resolve => {
          execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], (error, stdout) => {
            resolve(error ? null : stdout.trim() || null);
          });
        });
      },
      openInEditor: async cwd => {
        const opened = await new Promise<boolean>(resolve => {
          execFile('open', ['-a', 'Visual Studio Code', cwd], error => resolve(!error));
        });
        if (!opened) {
          const error = await openExternal(cwd);
          if (error) throw new Error(error);
        }
      },
    },
  };
}

function openExternal(target: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('open', [target], error => resolve(error ? String(error) : null));
  });
}
