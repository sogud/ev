import { execFile } from 'node:child_process';
import type { BrowserBridgeService } from '@ev/browser-host';
import type {
  FleetPaneFocus,
  FleetPaneRead,
  FleetSnapshot,
  ipcRegistry,
  DevicePresence,
  HandlersOf,
} from '@ev/contracts';
import type { AgentService } from './agent-service';
import type { ManagementService } from './management-service';

export interface ServerDeps {
  agents: AgentService;
  management: ManagementService;
  browserBridge: BrowserBridgeService;
  /** WS broadcast (tasks:update / auth:* / browserBridge:update). */
  broadcast: (channel: string, payload: unknown) => void;
  /** Device presence snapshot for the devices:list call. */
  listDevices: () => DevicePresence[];
  /** Last fleet snapshot for fleet:get (Herdr fleet view, herdr-fleet-v1). */
  fleetSnapshot: () => FleetSnapshot;
  /** On-demand pane output pull for fleet:readPane (never part of polling). */
  fleetReadPane: (paneId: string, lines?: number) => Promise<FleetPaneRead>;
  /** The fleet's single write operation for fleet:focusPane. */
  fleetFocusPane: (paneId: string) => Promise<FleetPaneFocus>;
}

/**
 * ipcRegistry handlers moved wholesale from desktop ipc.ts (a move, not a rewrite).
 * Electron-free: chooseDirectory returns null headless (clients collect paths
 * themselves); openPath/openInEditor use the system `open`.
 */
export function buildHandlers(deps: ServerDeps): HandlersOf<typeof ipcRegistry> {
  const { agents, management, browserBridge } = deps;
  return {
    tasks: {
      list: () => agents.listTasks(),
      get: id => agents.getTask(id),
      create: (cwd, runtimeId) => agents.createTask(cwd, runtimeId),
      remove: id => agents.removeTask(id),
      prompt: (id, prompt, images, queue) => agents.prompt(id, prompt, images, queue),
      commands: id => agents.commands(id),
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
      // Read-only (native-auth-display-v1): catalog and auth status come straight
      // from the pi ModelRuntime; EV holds no credentials and keeps no model
      // library. supports* are booleans only and never expose secrets.
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
            // EV no longer performs provider auth: supports* stay false and key presence is never read.
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
      approvePairing: browserId => browserBridge.approvePendingPairing(browserId),
      rejectPairing: browserId => browserBridge.rejectPendingPairing(browserId),
      reconnect: browserId => browserBridge.requestReconnect(browserId),
      revokePairing: browserId => browserBridge.revokePairing(browserId),
    },
    settings: {
      get: () => management.getSettings(),
      update: input => management.updateSettings(input),
      // headless server has no native directory picker; clients collect paths themselves.
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
    devices: {
      list: () => deps.listDevices(),
    },
    fleet: {
      get: () => deps.fleetSnapshot(),
      readPane: (paneId, lines) => deps.fleetReadPane(paneId, lines),
      focusPane: paneId => deps.fleetFocusPane(paneId),
    },
  };
}

function openExternal(target: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('open', [target], error => resolve(error ? String(error) : null));
  });
}
