import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserBridgeService,
  BrowserCommandExecutor,
  BrowserControlServer,
  MediaDownloadService,
  stopStandaloneBrowserHost,
} from '@ev/browser-host';
import {
  findCallToken,
  parseHttpRoute,
  type DevicePresence,
  type EvWireMessage,
  type IssuedToken,
  type PermissionLevel,
} from '@ev/contracts';
import { WebSocketServer } from 'ws';
import { AgentService } from './agent-service';
import { createAppearanceStore } from './appearance-store';
import { createBrowserBridgeStore } from './browser-bridge-store';
import { ensureEvCliLauncher } from './cli-launcher';
import { buildHandlers } from './handlers';
import { defineFleetPlugin } from './herdr/fleet-service';
import { createEvKernel, type EvKernel } from './kernel/ev-kernel';
import * as lifecycle from './lifecycle';
import { ManagementService } from './management-service';

/**
 * HTTP+WS surface on a pure Node runtime (node:http + ws; ws is an existing
 * browser-host dependency, not a new one). The packaged entry runs the same path
 * under Electron-as-node (ELECTRON_RUN_AS_NODE).
 */

interface AbstractSocket {
  send(data: string): void;
}

interface ServerStartupResources {
  kernel?: EvKernel;
  agents?: AgentService;
  browserBridge?: BrowserBridgeService;
  browserControlServer?: BrowserControlServer;
  webSocketServer?: WebSocketServer;
  httpServers: Server[];
}

function listenHttpServer(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

const sockets = new Set<AbstractSocket>();

function broadcast(channel: string, payload: unknown): void {
  const message = JSON.stringify({ channel, payload } satisfies EvWireMessage);
  for (const ws of sockets) ws.send(message);
}

// ---- device presence (client-pairing-and-presence-v1, presence slice) ----
// Driven by live WS sessions: online = at least one open WS from that device id;
// offline entries stick around so the list shows "recently seen" devices.

interface DeviceState extends DevicePresence {
  wsCount: number;
}

const DEVICE_SEEN_LIMIT_MS = 7 * 24 * 3600 * 1000;
const deviceStates = new Map<string, DeviceState>();

function normalizeDeviceKind(kind: string): DevicePresence['kind'] {
  return kind === 'desktop' || kind === 'web' || kind === 'cli' ? kind : 'unknown';
}

function deviceSnapshot(): DevicePresence[] {
  return [...deviceStates.values()]
    .map(({ wsCount: _wsCount, ...presence }) => presence)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

function broadcastDevices(): void {
  broadcast('devices:update', deviceSnapshot());
}

function pruneStaleDevices(): void {
  const cutoff = Date.now() - DEVICE_SEEN_LIMIT_MS;
  for (const [id, state] of deviceStates) {
    if (state.wsCount === 0 && state.lastSeenAt < cutoff) deviceStates.delete(id);
  }
}

function trackDeviceOpen(id: string, name: string, kind: string): void {
  pruneStaleDevices();
  const state = deviceStates.get(id) ?? {
    id,
    name,
    kind: normalizeDeviceKind(kind),
    online: false,
    connectedAt: null,
    lastSeenAt: 0,
    wsCount: 0,
  };
  state.name = name;
  state.kind = normalizeDeviceKind(kind);
  state.wsCount += 1;
  state.online = true;
  state.connectedAt ??= Date.now();
  state.lastSeenAt = Date.now();
  deviceStates.set(id, state);
  broadcastDevices();
}

function trackDeviceClose(id: string): void {
  const state = deviceStates.get(id);
  if (!state) return;
  state.wsCount = Math.max(0, state.wsCount - 1);
  if (state.wsCount === 0) state.online = false;
  state.lastSeenAt = Date.now();
  broadcastDevices();
}

function readOrCreateToken(): string {
  const dir = evDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tokenPath = join(dir, 'token');
  if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim();
  const token = randomBytes(24).toString('hex');
  writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  return token;
}

/** P3 remote access: ~/.ev/remote.json {enabled} switch, default false. */
function readRemoteEnabled(): boolean {
  try {
    return Boolean(JSON.parse(readFileSync(join(evDataDir(), 'remote.json'), 'utf8'))?.enabled);
  } catch {
    return false;
  }
}

/** 100.64.0.0/10 (Tailscale CGNAT); other private ranges count as LAN. Public ranges are never bound. */
function isTailscaleV4(ip: string): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
}
function isPrivateV4(ip: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || isTailscaleV4(ip);
}
function privateInterfaces(): { lan: string[]; tailscale: string[] } {
  const lan: string[] = [];
  const tailscale: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateV4(entry.address)) {
        (isTailscaleV4(entry.address) ? tailscale : lan).push(entry.address);
      }
    }
  }
  return { lan, tailscale };
}

/** Tiered token table (~/.ev/tokens.json, mode 600); read per request, the file is tiny. */
function readIssuedTokens(): IssuedToken[] {
  try {
    const raw = JSON.parse(readFileSync(join(evDataDir(), 'tokens.json'), 'utf8')) as {
      tokens?: IssuedToken[];
    };
    return Array.isArray(raw.tokens) ? raw.tokens : [];
  } catch {
    return [];
  }
}

function tokenTier(mainToken: string, auth: string): PermissionLevel | null {
  if (auth === mainToken) return 'operator';
  return readIssuedTokens().find(item => item.token === auth)?.tier ?? null;
}

const here = dirname(fileURLToPath(import.meta.url));

/** EV_HOME overrides the data directory so tests/golden never touch the user's real store. */
function evDataDir(): string {
  return process.env.EV_HOME?.trim() ?? join(homedir(), '.ev');
}

const rendererDir = (): string =>
  process.env.EV_RENDERER_DIR ?? join(here, '../../desktop/dist-electron/renderer');

const mobileDir = (): string => process.env.EV_MOBILE_DIR ?? join(here, '../dist-mobile');

function serveMobile(pathname: string): { status: number; type: string; body: Buffer } | null {
  if (pathname === '/m' || pathname === '/m/') pathname = '/m/index.html';
  if (!pathname.startsWith('/m/')) return null;
  const rootDir = mobileDir();
  const relative = pathname.slice(3).replace(/\/+$/, '');
  const file = join(rootDir, relative);
  if (!file.startsWith(rootDir) || !existsSync(file)) return null;
  const ext = '.' + (relative.split('.').pop() ?? '');
  return { status: 200, type: MIME[ext] ?? 'application/octet-stream', body: readFileSync(file) };
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveRenderer(pathname: string): { status: number; type: string; body: Buffer } | null {
  const root = rendererDir();
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const file = join(root, relative);
  if (!file.startsWith(root) || !existsSync(file)) return null;
  const ext = '.' + (relative.split('.').pop() ?? '');
  return { status: 200, type: MIME[ext] ?? 'application/octet-stream', body: readFileSync(file) };
}

interface DispatchResult {
  status: number;
  json?: unknown;
  file?: { type: string; body: Buffer };
  text?: string;
}

function makeDispatcher(token: string, handlers: unknown) {
  return async function dispatch(
    method: string,
    pathname: string,
    searchParams: URLSearchParams,
    authHeader: string | null,
    bodyText: string | null
  ): Promise<DispatchResult> {
    if (pathname === '/ws') {
      // WS upgrades are handled by the runtime adapters; this is only the token pre-check.
      return searchParams.get('token') === token
        ? { status: 101 }
        : { status: 403, text: 'forbidden' };
    }
    if (pathname === '/health') return { status: 200, json: { ok: true } };
    if (method === 'GET') {
      const mobile = serveMobile(pathname);
      if (mobile) return { status: 200, file: { type: mobile.type, body: mobile.body } };
      const served = serveRenderer(pathname);
      if (served) return { status: 200, file: { type: served.type, body: served.body } };
    }
    const route = parseHttpRoute(pathname);
    if (!route || method !== 'POST') return { status: 404, text: 'not found' };
    const auth = (authHeader ?? '').replace(/^Bearer /, '');
    const level = tokenTier(token, auth);
    if (!level) return { status: 401, json: { error: 'unauthorized' } };
    const tokenDef = findCallToken(route.namespace, route.method);
    if (!tokenDef) return { status: 404, json: { error: 'unknown call' } };
    // P3 tiers: observer calling an operator call gets 403; the local main token is operator.
    if (tokenDef.perm === 'operator' && level !== 'operator')
      return { status: 403, json: { error: 'forbidden' } };
    let args: unknown[] = [];
    try {
      const parsed = bodyText ? (JSON.parse(bodyText) as { args?: unknown[] }) : {};
      args = Array.isArray(parsed.args) ? parsed.args : [];
    } catch {
      args = [];
    }
    const nsHandlers = handlers as Record<string, Record<string, (...a: unknown[]) => unknown>>;
    try {
      const fn = nsHandlers[route.namespace]?.[route.method];
      if (typeof fn !== 'function') {
        console.error(`[EV] missing handler ${route.namespace}:${route.method}`);
        return { status: 404, json: { error: 'missing handler' } };
      }
      const result = await fn(...args);
      return { status: 200, json: result ?? null };
    } catch (error) {
      console.error(`[EV] ${route.namespace}:${route.method} failed`, error);
      return {
        status: 500,
        json: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  };
}

async function main(resources: ServerStartupResources): Promise<void> {
  if (lifecycle.runningServerInfo()) {
    console.error('EV server already running (see ~/.ev/server.json)');
    process.exit(1);
  }
  const home = homedir();
  const token = readOrCreateToken();
  const port = Number(process.env.EV_PORT ?? 7877);

  const dataHome = evDataDir();
  const defaultWorkspace = join(dataHome, 'workspace');
  mkdirSync(defaultWorkspace, { recursive: true, mode: 0o700 });

  // Packaged layout puts the CLI at resources/cli/ev.js next to resources/server/;
  // dev keeps the repo build at apps/cli/dist/ev.js.
  const cliScript =
    process.env.EV_CLI_SCRIPT ??
    [join(here, '../cli/ev.js'), join(here, '../../cli/dist/ev.js')].find(candidate =>
      existsSync(candidate)
    ) ??
    join(here, '../../cli/dist/ev.js');
  try {
    const launcher = await ensureEvCliLauncher({
      homeDirectory: home,
      binDirectory: join(dataHome, 'bin'),
      executablePath: process.execPath,
      cliScript,
    });
    process.env.EV_CLI_PATH = launcher.launcherPath;
    process.env.EV_CLI_BIN_DIR = dirname(launcher.launcherPath);
  } catch (error) {
    console.error('[EV CLI] Unable to install launcher:', error);
  }
  const browserSkill = join(here, '../../../skills/ev-browser');

  const kernel = await createEvKernel();
  resources.kernel = kernel;
  // Herdr fleet bridge (herdr-fleet-v1): optional local dependency; the loop
  // probes with backoff and never blocks startup. Stop is owned by the kernel
  // fiber cleanup. EV_HERDR_PATH / EV_FLEET_INTERVAL_MS configure test fakes.
  const fleetIntervalMs = Number(process.env.EV_FLEET_INTERVAL_MS);
  await kernel.context.plugin(
    defineFleetPlugin({
      broadcast,
      herdrPath: process.env.EV_HERDR_PATH?.trim() || undefined,
      intervalMs:
        Number.isFinite(fleetIntervalMs) && fleetIntervalMs > 0 ? fleetIntervalMs : undefined,
    })
  );
  const agents = await AgentService.create(kernel.runtimes, {
    defaultWorkspace,
    legacyDefaultWorkspaces: [home],
    bundledSkillPaths: [browserSkill],
  });
  resources.agents = agents;
  const management = new ManagementService(agents, defaultWorkspace, createAppearanceStore());
  const browserBridge = new BrowserBridgeService({
    store: createBrowserBridgeStore(),
    // CLI-first: a freshly installed extension pairs without a desktop
    // approval click; identity is pinned after the first pairing.
    pairingMode: 'automatic',
  });
  resources.browserBridge = browserBridge;
  const browserRuntimeDirectory = join(evDataDir(), 'run');
  // Stop any standalone host BEFORE the embedded bridge binds, otherwise the
  // embedded start hits EADDRINUSE (swallowed below) and then the standalone
  // is killed, leaving port 43121 ownerless and the extension orphaned.
  await stopStandaloneBrowserHost(browserRuntimeDirectory);
  try {
    await browserBridge.start();
  } catch {
    // clients keep working without browser integration.
  }
  const mediaDownloads = new MediaDownloadService({
    downloadDirectory: join(home, 'Downloads', 'EV'),
  });
  const browserControlServer = new BrowserControlServer(
    new BrowserCommandExecutor(browserBridge, mediaDownloads),
    { runtimeDirectory: browserRuntimeDirectory }
  );
  resources.browserControlServer = browserControlServer;
  try {
    await browserControlServer.start();
  } catch (error) {
    console.error('[EV Browser Control] Unable to start local CLI socket:', error);
  }

  const handlers = buildHandlers({
    agents,
    management,
    browserBridge,
    broadcast,
    listDevices: deviceSnapshot,
    fleetSnapshot: () => kernel.context.fleet.snapshot(),
    fleetReadPane: (paneId, lines) => kernel.context.fleet.readPane(paneId, lines),
    fleetFocusPane: paneId => kernel.context.fleet.focusPane(paneId),
  });
  agents.setListener(task => broadcast('tasks:update', task));
  browserBridge.subscribe(snapshot => broadcast('browserBridge:update', snapshot));

  const dispatch = makeDispatcher(token, handlers);

  // In dev the renderer runs on the vite origin (localhost:5173) and needs CORS
  // for cross-origin fetch; the whitelist covers only vite's default port. Prod is
  // same-origin and never relies on this header, so the security posture is unchanged.
  const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
  const corsHeaders = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (!origin || !DEV_ORIGINS.has(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
    };
  };

  const wss = new WebSocketServer({ noServer: true });
  resources.webSocketServer = wss;
  const httpServers = resources.httpServers;
  let shuttingDown = false;
  const buildHttpServer = (): ReturnType<typeof createServer> => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (shuttingDown) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'server is shutting down' }));
        return;
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }
      let body = '';
      let bodyBytes = 0;
      let bodyTooLarge = false;
      req.on('data', chunk => {
        bodyBytes += Buffer.byteLength(chunk);
        if (bodyBytes > 30 * 1024 * 1024) {
          bodyTooLarge = true;
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (bodyTooLarge) {
          res.writeHead(413, { 'content-type': 'application/json', ...corsHeaders(req) });
          res.end(JSON.stringify({ error: 'request body is too large' }));
          return;
        }
        void dispatch(
          req.method ?? 'GET',
          url.pathname,
          url.searchParams,
          req.headers.authorization ?? null,
          body
        ).then(result => {
          if (result.file) {
            res.writeHead(result.status, { 'content-type': result.file.type, ...corsHeaders(req) });
            res.end(result.file.body);
            return;
          }
          res.writeHead(result.status, { 'content-type': 'application/json', ...corsHeaders(req) });
          // Void handlers resolve json:null — only fall back to the error shape
          // when the dispatch result carries neither json nor text.
          const body =
            'json' in result && result.json !== undefined
              ? JSON.stringify(result.json)
              : JSON.stringify({ error: result.text ?? '' });
          res.end(body);
        });
      });
    });
    srv.on('upgrade', (req, socket, head) => {
      if (shuttingDown) {
        socket.destroy();
        return;
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const wsToken = url.searchParams.get('token') ?? '';
      if (url.pathname !== '/ws' || !tokenTier(token, wsToken)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        sockets.add(ws as unknown as AbstractSocket);
        const deviceId = url.searchParams.get('device');
        if (deviceId) {
          trackDeviceOpen(
            deviceId,
            url.searchParams.get('deviceName') ?? 'Unknown',
            url.searchParams.get('deviceKind') ?? 'unknown'
          );
        }
        ws.on('close', () => {
          sockets.delete(ws as unknown as AbstractSocket);
          if (deviceId) trackDeviceClose(deviceId);
        });
      });
    });
    httpServers.push(srv);
    return srv;
  };
  const httpServer = buildHttpServer();
  await listenHttpServer(httpServer, port, '127.0.0.1');
  // R1: with remote enabled, additionally bind every private interface
  // (LAN+Tailscale); never 0.0.0.0/public. Non-loopback gets the same mandatory
  // token as loopback (Bearer check on every /api call).
  let lanIps: string[] = [];
  let tailscaleIp: string | null = null;
  if (readRemoteEnabled()) {
    const found = privateInterfaces();
    lanIps = found.lan;
    tailscaleIp = found.tailscale[0] ?? null;
    for (const ip of [...lanIps, ...found.tailscale]) {
      await listenHttpServer(buildHttpServer(), port, ip);
      void fetch(`http://${ip}:${port}/health`)
        .then(result =>
          console.log(
            `[EV] remote self-check ${result.ok ? 'ok' : 'fail'}: http://${ip}:${port}/health`
          )
        )
        .catch(() => console.warn(`[EV] remote self-check failed: ${ip}`));
    }
    if (lanIps.length === 0 && !tailscaleIp)
      console.warn(
        '[EV] remote enabled but no private interface found; listening on localhost only'
      );
  }

  lifecycle.writeServerInfo({
    port,
    token,
    pid: process.pid,
    version: '0.1.0',
    startedAt: Date.now(),
    lanIps,
    tailscaleIp,
  });
  console.log(
    `EV server listening on http://127.0.0.1:${port}` +
      (lanIps.length ? ` + lan ${lanIps.map(ip => `http://${ip}:${port}`).join(' ')}` : '') +
      (tailscaleIp ? ` + tailscale http://${tailscaleIp}:${port}` : '')
  );

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle.clearServerInfo();
    const forcedExit = setTimeout(() => process.exit(1), 30_000);
    forcedExit.unref();
    void (async () => {
      for (const client of wss.clients) client.terminate();
      await Promise.allSettled([
        ...httpServers.map(server => closeHttpServer(server)),
        browserControlServer.stop(),
        browserBridge.stop(),
      ]);
      const failures: unknown[] = [];
      try {
        await agents.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        await kernel.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Unable to dispose every EV Server resource');
      }
    })().then(
      () => {
        clearTimeout(forcedExit);
        process.exit(0);
      },
      error => {
        process.stderr.write(
          `[EV] Unable to dispose every runtime during shutdown: ${error instanceof Error ? error.message : String(error)}\n`
        );
        clearTimeout(forcedExit);
        process.exit(1);
      }
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function runServer(): Promise<void> {
  const resources: ServerStartupResources = { httpServers: [] };
  try {
    await main(resources);
  } catch (startupError) {
    const failures: unknown[] = [startupError];
    for (const client of resources.webSocketServer?.clients ?? []) client.terminate();
    const networkResults = await Promise.allSettled([
      ...resources.httpServers.map(server => closeHttpServer(server)),
      resources.browserControlServer?.stop(),
      resources.browserBridge?.stop(),
    ]);
    failures.push(
      ...networkResults.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    );
    try {
      await resources.agents?.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await resources.kernel?.dispose();
    } catch (error) {
      failures.push(error);
    }
    throw new AggregateError(failures, 'EV Server startup failed');
  }
}

void runServer().then(undefined, error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
