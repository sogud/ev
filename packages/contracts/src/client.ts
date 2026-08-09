/**
 * EV 参考客户端：fetch(HTTP) + WebSocket(事件)，node/bun/browser 通用。
 * CLI、desktop renderer、Web 都用它生成与 AgentDesktopAPI 同形的对象。
 */
import type { AgentDesktopAPI, EvWireMessage } from './registry';
import { ipcRegistry, isIpcToken, type CallToken } from './registry';

export interface EvClientOptions {
  baseUrl: string; // e.g. http://127.0.0.1:7877
  token: string;
}

export type EvClient = AgentDesktopAPI & {
  /** WS 事件订阅（tasks:update 等），返回 unsubscribe；首次订阅时懒建连接。 */
  onWire(channel: string, listener: (payload: unknown) => void): () => void;
  /** WS 断线自动重连（退避）成功后回调；调用方应全量 refetch 收敛丢失事件。 */
  onReconnect(listener: () => void): () => void;
  close(): void;
};

export function createEvClient(options: EvClientOptions): EvClient {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const reconnectListeners = new Set<() => void>();
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
        // 重连成功：通知调用方全量 refetch，收敛断线期间丢失的事件。
        if (isReconnect) for (const listener of reconnectListeners) listener();
      };
      ws.onerror = () => reject(new Error('EV server WebSocket 连接失败'));
      ws.onmessage = message => {
        try {
          const wire = JSON.parse(String(message.data)) as EvWireMessage;
          const set = listeners.get(wire.channel);
          if (set) for (const listener of set) listener(wire.payload);
        } catch {
          // 坏帧忽略，保持连接。
        }
      };
      ws.onclose = () => {
        socket = null;
        socketPromise = null;
        // 断线退避重连（1s→2s→4s…≤8s）；close() 后不再重连。
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
  api.onReconnect = listener => {
    reconnectListeners.add(listener);
    return () => {
      reconnectListeners.delete(listener);
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
