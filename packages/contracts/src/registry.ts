/**
 * EV 调用/事件契约唯一处：call/event token + 权限分级 + HTTP/WS 映射。
 * server 按它挂路由与强制权限；CLI/desktop/Web 按它生成客户端。
 * 通道字符串全仓唯一处（server-client-split-v1 定案）。
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

/** 权限分级（P3 远程接入的必选项，契约第一天实现）：observer=只读+审批，operator=全操作。 */
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
    // 只读（native-auth-display-v1）：EV 零凭据持有，登录类 call 全删。
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

/** 客户端 API 形状（CLI/desktop/Web 对等）。 */
export type ClientOf<Node> = {
  readonly [K in keyof Node]: Node[K] extends AnyToken ? ClientLeaf<Node[K]> : ClientOf<Node[K]>;
};

type HandlerLeaf<T> =
  T extends CallToken<infer Args, infer Ret> ? (...args: Args) => Ret | Promise<Ret> : never;

/** server 侧 handler 对象形状：与 registry 同形，漏/多一个 handler 都是编译错误。 */
export type HandlersOf<Node> = {
  readonly [K in keyof Node as Node[K] extends EventToken<unknown> ? never : K]: Node[K] extends
    CallToken<unknown[], unknown> | EventToken<unknown>
    ? HandlerLeaf<Node[K]>
    : HandlersOf<Node[K]>;
};

export type AgentDesktopAPI = ClientOf<typeof ipcRegistry>;

// ---- HTTP / WS 映射（server-client-split-v1）----

/** HTTP 路由：POST /api/<ns>/<method>，body = { args: [...] }。 */
export function httpRoute(namespace: string, method: string): string {
  return `/api/${namespace}/${method}`;
}

export function parseHttpRoute(pathname: string): { namespace: string; method: string } | null {
  const match = /^\/api\/([a-zA-Z]+)\/([a-zA-Z]+)$/.exec(pathname);
  if (!match) return null;
  return { namespace: match[1], method: match[2] };
}

/** 在 registry 里按 channel 找 call token（server 路由分发/权限检查用）。 */
export function findCallToken(
  namespace: string,
  method: string
): CallToken<unknown[], unknown> | null {
  const ns = (ipcRegistry as Record<string, Record<string, AnyToken>>)[namespace];
  const token = ns?.[method];
  return token && token.kind === 'call' ? (token as CallToken<unknown[], unknown>) : null;
}

/** WS 线上消息：单连接多路复用，channel 与 event token 同名。 */
export interface EvWireMessage {
  channel: string;
  payload: unknown;
}

// ---- 认证 / 生命周期 ----

/** ~/.ev/server.json 内容：客户端发现 server 的唯一入口。 */
export interface ServerInfo {
  port: number;
  token: string;
  pid: number;
  version: string;
  startedAt: number;
  /** remote.enabled 时绑定的私网地址（绝不 0.0.0.0/公网）；缺省=仅 loopback。 */
  lanIps?: string[];
  tailscaleIp?: string | null;
}

/** ~/.ev/tokens.json 里的分级远程 token（P3 远程接入）。 */
export interface IssuedToken {
  id: string;
  token: string;
  tier: PermissionLevel;
  createdAt: number;
}

export const EV_SERVER_JSON_PATH_HINT = '~/.ev/server.json';
