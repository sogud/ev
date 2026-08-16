/**
 * Single home for the EV call/event contract: call/event tokens + permission tiers + HTTP/WS mapping.
 * The server mounts routes and enforces permissions from it; CLI/desktop/web generate clients from it.
 * Channel strings are repo-wide unique here (settled in server-client-split-v1).
 */
import type {
  AppSettings,
  BrowserBridgeSnapshot,
  ProviderSummary,
  ResourceSettingsInput,
  ResourceSnapshot,
  TaskDetail,
  TaskInspection,
  TaskSummary,
  ThinkingLevel,
} from './domain';
import type { RuntimeDescriptor, RuntimeId } from './runtime';

/** A client shell connected to the server; presence is driven by live WS sessions. */
export interface DevicePresence {
  /** Stable per client install (persisted client-side). */
  id: string;
  name: string;
  kind: 'desktop' | 'web' | 'cli' | 'unknown';
  online: boolean;
  connectedAt: number | null;
  lastSeenAt: number;
}

/** Permission tiers (required by P3 remote access, implemented since day one): observer = read-only + approvals, operator = full control. */
export type PermissionLevel = 'observer' | 'operator';

export interface CallToken<Args extends unknown[], Ret> {
  readonly kind: 'call';
  readonly channel: string;
  readonly perm: PermissionLevel;
  readonly _args?: Args;
  readonly _ret?: Ret;
}

export interface EventToken<Payload> {
  readonly kind: 'event';
  readonly channel: string;
  readonly _payload?: Payload;
}

export const call = <Args extends unknown[], Ret>(
  channel: string,
  perm: PermissionLevel
): CallToken<Args, Ret> => ({ kind: 'call', channel, perm });

export const event = <Payload>(channel: string): EventToken<Payload> => ({
  kind: 'event',
  channel,
});

export const ipcRegistry = {
  tasks: {
    list: call<[], TaskSummary[]>('tasks:list', 'observer'),
    get: call<[string], TaskDetail>('tasks:get', 'observer'),
    create: call<[string | undefined, RuntimeId | undefined], TaskDetail>(
      'tasks:create',
      'operator'
    ),
    remove: call<[string], void>('tasks:remove', 'operator'),
    prompt: call<[string, string], void>('tasks:prompt', 'operator'),
    abort: call<[string], void>('tasks:abort', 'operator'),
    setRuntime: call<[string, RuntimeId], void>('tasks:setRuntime', 'operator'),
    setModel: call<[string, string, string], void>('tasks:setModel', 'operator'),
    setThinkingLevel: call<[string, ThinkingLevel], void>('tasks:setThinkingLevel', 'operator'),
    onUpdate: event<TaskDetail>('tasks:update'),
  },
  runtimes: {
    list: call<[], RuntimeDescriptor[]>('runtimes:list', 'observer'),
  },
  inspection: {
    get: call<[string], TaskInspection>('inspection:get', 'observer'),
  },
  providers: {
    // Read-only (native-auth-display-v1): EV holds zero credentials; all login calls are removed.
    list: call<[], ProviderSummary[]>('providers:list', 'observer'),
  },
  resources: {
    get: call<[], ResourceSnapshot>('resources:get', 'observer'),
    update: call<[ResourceSettingsInput], ResourceSnapshot>('resources:update', 'operator'),
  },
  browserBridge: {
    get: call<[], BrowserBridgeSnapshot>('browserBridge:get', 'observer'),
    approvePairing: call<[], BrowserBridgeSnapshot>('browserBridge:approvePairing', 'observer'),
    rejectPairing: call<[], BrowserBridgeSnapshot>('browserBridge:rejectPairing', 'observer'),
    reconnect: call<[], BrowserBridgeSnapshot>('browserBridge:reconnect', 'operator'),
    revokePairing: call<[], BrowserBridgeSnapshot>('browserBridge:revokePairing', 'operator'),
    onUpdate: event<BrowserBridgeSnapshot>('browserBridge:update'),
  },
  settings: {
    get: call<[], AppSettings>('settings:get', 'observer'),
    update: call<[Partial<AppSettings>], AppSettings>('settings:update', 'operator'),
    chooseDirectory: call<[], string | null>('settings:chooseDirectory', 'operator'),
    openPath: call<[string], void>('settings:openPath', 'operator'),
  },
  workspace: {
    gitBranch: call<[string], string | null>('workspace:gitBranch', 'observer'),
    openInEditor: call<[string], void>('workspace:openInEditor', 'operator'),
  },
  devices: {
    list: call<[], DevicePresence[]>('devices:list', 'observer'),
    onUpdate: event<DevicePresence[]>('devices:update'),
  },
};

export type IpcRegistry = typeof ipcRegistry;

type AnyToken = CallToken<unknown[], unknown> | EventToken<unknown>;

export function isIpcToken(value: unknown): value is AnyToken {
  return (
    typeof value === 'object' &&
    value !== null &&
    ((value as AnyToken).kind === 'call' || (value as AnyToken).kind === 'event')
  );
}

type ClientLeaf<T> =
  T extends CallToken<infer Args, infer Ret>
    ? (...args: Args) => Promise<Ret>
    : T extends EventToken<infer Payload>
      ? (listener: (payload: Payload) => void) => () => void
      : never;

/** Client API shape (CLI/desktop/web are peers). */
export type ClientOf<Node> = {
  readonly [K in keyof Node]: Node[K] extends AnyToken ? ClientLeaf<Node[K]> : ClientOf<Node[K]>;
};

type HandlerLeaf<T> =
  T extends CallToken<infer Args, infer Ret> ? (...args: Args) => Ret | Promise<Ret> : never;

/** Server-side handler object shape: mirrors the registry; a missing or extra handler is a compile error. */
export type HandlersOf<Node> = {
  readonly [K in keyof Node as Node[K] extends EventToken<unknown> ? never : K]: Node[K] extends
    CallToken<unknown[], unknown> | EventToken<unknown>
    ? HandlerLeaf<Node[K]>
    : HandlersOf<Node[K]>;
};

export type AgentDesktopAPI = ClientOf<typeof ipcRegistry>;

// ---- HTTP / WS mapping (server-client-split-v1) ----

/** HTTP route: POST /api/<ns>/<method>, body = { args: [...] }. */
export function httpRoute(namespace: string, method: string): string {
  return `/api/${namespace}/${method}`;
}

export function parseHttpRoute(pathname: string): { namespace: string; method: string } | null {
  const match = /^\/api\/([a-zA-Z]+)\/([a-zA-Z]+)$/.exec(pathname);
  if (!match) return null;
  return { namespace: match[1], method: match[2] };
}

/** Find a call token by channel in the registry (server route dispatch / permission checks). */
export function findCallToken(
  namespace: string,
  method: string
): CallToken<unknown[], unknown> | null {
  const ns = (ipcRegistry as Record<string, Record<string, AnyToken>>)[namespace];
  const token = ns?.[method];
  return token && token.kind === 'call' ? (token as CallToken<unknown[], unknown>) : null;
}

/** WS wire message: one connection multiplexed; channel shares the event token name. */
export interface EvWireMessage {
  channel: string;
  payload: unknown;
}

// ---- auth / lifecycle ----

/** Contents of ~/.ev/server.json: the only entry for clients to discover the server. */
export interface ServerInfo {
  port: number;
  token: string;
  pid: number;
  version: string;
  startedAt: number;
  /** Private addresses bound when remote.enabled (never 0.0.0.0/public); absent = loopback only. */
  lanIps?: string[];
  tailscaleIp?: string | null;
}

/** Tiered remote tokens stored in ~/.ev/tokens.json (P3 remote access). */
export interface IssuedToken {
  id: string;
  token: string;
  tier: PermissionLevel;
  createdAt: number;
}

export const EV_SERVER_JSON_PATH_HINT = '~/.ev/server.json';
