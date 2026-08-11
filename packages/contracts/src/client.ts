/**
 * Reference EV client: fetch (HTTP) + WebSocket (events); works in node/browser.
 * CLI, desktop renderer and web all build AgentDesktopAPI-shaped objects from it.
 */
import type { TaskDetail, TaskSummary } from './domain';
import type { AgentDesktopAPI, EvWireMessage } from './registry';
import { ipcRegistry, isIpcToken, type CallToken } from './registry';

export interface EvClientOptions {
  baseUrl: string; // e.g. http://127.0.0.1:7877
  token: string;
}

export type EvClient = AgentDesktopAPI & {
  /** WS event subscription (tasks:update etc.); returns unsubscribe; connection is lazy on first subscribe. */
  onWire(channel: string, listener: (payload: unknown) => void): () => void;
  /**
   * Deep sync: keep a cached task list, apply tasks:update locally, and refetch
   * fully after every reconnect. UI clients activate once; CLI one-shots never
   * call it and stay WS-free.
   */
  enableTaskSync(): void;
  /** Read-through cached task list (first call fetches). */
  taskList(): Promise<TaskSummary[]>;
  /** Subscribe to the cached list; fires on upsert and on post-reconnect refetch. */
  subscribeTaskList(listener: (tasks: TaskSummary[]) => void): () => void;
  /**
   * Fires after the client converged the list post-reconnect. Thin-delegation
   * hook for state the client cannot know (e.g. the currently open detail).
   */
  onResynced(listener: () => void): () => void;
  close(): void;
};

export function createEvClient(options: EvClientOptions): EvClient {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const resyncedListeners = new Set<() => void>();
  let taskCache: TaskSummary[] | null = null;
  const taskCacheListeners = new Set<(tasks: TaskSummary[]) => void>();
  let taskSyncEnabled = false;
  let socket: WebSocket | null = null;
  let socketPromise: Promise<WebSocket> | null = null;
  let closed = false;
  let hadOpen = false;
  let backoffMs = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): Promise<WebSocket> => {
    if (socket) return Promise.resolve(socket);
    if (socketPromise) return socketPromise;
    const url = options.baseUrl.replace(/^http/, 'ws') + '/ws?token=' + options.token;
    socketPromise = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        socket = ws;
        const isReconnect = hadOpen;
        hadOpen = true;
        backoffMs = 1000;
        resolve(ws);
        // Reconnect succeeded: the cache converges itself (full refetch); consumers
        // only get a thin notification for state the client cannot know.
        if (isReconnect && taskSyncEnabled) void resyncTaskCache();
      };
      ws.onerror = () => reject(new Error('EV server WebSocket connection failed'));
      ws.onmessage = message => {
        try {
          const wire = JSON.parse(String(message.data)) as EvWireMessage;
          const set = listeners.get(wire.channel);
          if (set) for (const listener of set) listener(wire.payload);
        } catch {
          // Ignore bad frames; keep the connection alive.
        }
      };
      ws.onclose = () => {
        socket = null;
        socketPromise = null;
        // Backoff reconnect (1s -> 2s -> 4s ... <= 8s); no reconnect after close().
        if (!closed) {
          reconnectTimer = setTimeout(() => {
            void connect().catch(() => undefined);
          }, backoffMs);
          backoffMs = Math.min(backoffMs * 2, 8000);
        }
      };
    });
    return socketPromise;
  };

  const invoke = async (
    token: CallToken<unknown[], unknown>,
    args: unknown[]
  ): Promise<unknown> => {
    const response = await fetch(options.baseUrl + '/api/' + token.channel.replace(':', '/'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + options.token,
      },
      body: JSON.stringify({ args }),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body;
  };

  const buildLeaf = (token: CallToken<unknown[], unknown> | { kind: 'event'; channel: string }) => {
    if (token.kind === 'call') {
      return (...args: unknown[]) => invoke(token, args);
    }
    const channel = token.channel;
    return (listener: (payload: unknown) => void) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
      void connect().catch(() => undefined);
      return () => {
        set.delete(listener);
      };
    };
  };

  const buildNode = (node: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = isIpcToken(value) ? buildLeaf(value) : buildNode(value as Record<string, unknown>);
    }
    return out;
  };

  const api = buildNode(ipcRegistry as unknown as Record<string, unknown>) as EvClient;
  const rawTaskList = api.tasks.list;

  const notifyTaskCache = (): void => {
    if (!taskCache) return;
    for (const listener of taskCacheListeners) listener([...taskCache]);
  };

  const sortByUpdated = (tasks: TaskSummary[]): TaskSummary[] =>
    [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);

  const upsertTask = (detail: TaskDetail): void => {
    const { messages: _messages, trace: _trace, ...summary } = detail;
    const rest = taskCache?.filter(task => task.id !== summary.id) ?? [];
    taskCache = sortByUpdated([...rest, summary]);
    notifyTaskCache();
  };

  const resyncTaskCache = async (): Promise<void> => {
    try {
      taskCache = sortByUpdated(await rawTaskList());
    } catch {
      // server still coming back; the next reconnect or event re-converges.
      return;
    }
    notifyTaskCache();
    for (const listener of resyncedListeners) listener();
  };
  api.onWire = (channel, listener) => {
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(listener);
    void connect().catch(() => undefined);
    return () => {
      set.delete(listener);
    };
  };
  api.enableTaskSync = () => {
    if (taskSyncEnabled) return;
    taskSyncEnabled = true;
    api.onWire('tasks:update', payload => upsertTask(payload as TaskDetail));
    void resyncTaskCache();
  };
  api.taskList = async () => {
    if (taskCache) return [...taskCache];
    taskCache = sortByUpdated(await rawTaskList());
    notifyTaskCache();
    return [...taskCache];
  };
  api.subscribeTaskList = listener => {
    taskCacheListeners.add(listener);
    return () => {
      taskCacheListeners.delete(listener);
    };
  };
  api.onResynced = listener => {
    resyncedListeners.add(listener);
    return () => {
      resyncedListeners.delete(listener);
    };
  };
  api.close = () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
  };
  return api;
}
