import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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
import * as lifecycle from './lifecycle';
import { ClaudeFamilyAdapter, CLAUDE_CODE_FLAVOR, QODER_FLAVOR } from './runtime/claude-family';
import { CodexAppServerAdapter } from './runtime/codex-app-server-adapter';
import { PiRpcAdapter } from './runtime/pi-rpc-adapter';
import { RuntimeRegistry } from './runtime/runtime-registry';
import { ManagementService } from './management-service';

/**
 * HTTP+WS 服务面：纯 Node 运行时（node:http + ws；ws 为 browser-host 既有依赖，非新增）。
 * 打包 entry 在 Electron-as-node（ELECTRON_RUN_AS_NODE）下同路径运行。
 */

interface AbstractSocket {
  send(data: string): void;
}
const sockets = new Set<AbstractSocket>();

function broadcast(channel: string, payload: unknown): void {
  const message = JSON.stringify({ channel, payload } satisfies EvWireMessage);
  for (const ws of sockets) ws.send(message);
}

function readOrCreateToken(): string {
  const dir = join(homedir(), '.ev');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tokenPath = join(dir, 'token');
  if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim();
  const token = randomBytes(24).toString('hex');
  writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  return token;
}

/** P3 远程接入：~/.ev/remote.json {enabled} 开关，默认 false。 */
function readRemoteEnabled(): boolean {
  try {
    return Boolean(
      JSON.parse(readFileSync(join(homedir(), '.ev', 'remote.json'), 'utf8'))?.enabled
    );
  } catch {
    return false;
  }
}

/** 100.64.0.0/10（Tailscale CGNAT 段）；其余私网段视为 LAN。公网段一律不绑。 */
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

/** 分级 token 表（~/.ev/tokens.json，600）；每请求读，文件极小。 */
function readIssuedTokens(): IssuedToken[] {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.ev', 'tokens.json'), 'utf8')) as {
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
      // WS 升级由各运行时适配器单独处理；这里只做 token 预判。
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
    // P3 分级：observer 调 operator call → 403；本地主 token = operator。
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
      const result = await nsHandlers[route.namespace][route.method](...args);
      return { status: 200, json: result ?? null };
    } catch (error) {
      return {
        status: 500,
        json: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  };
}

async function main(): Promise<void> {
  if (lifecycle.runningServerInfo()) {
    console.error('EV server already running (see ~/.ev/server.json)');
    process.exit(1);
  }
  const home = homedir();
  const token = readOrCreateToken();
  const port = Number(process.env.EV_PORT ?? 7877);

  const defaultWorkspace = join(home, '.ev', 'workspace');
  mkdirSync(defaultWorkspace, { recursive: true, mode: 0o700 });

  const cliScript = process.env.EV_CLI_SCRIPT ?? join(here, '../../cli/dist/ev.js');
  try {
    const launcher = await ensureEvCliLauncher({
      homeDirectory: home,
      executablePath: process.execPath,
      cliScript,
    });
    process.env.EV_CLI_PATH = launcher.launcherPath;
    process.env.EV_CLI_BIN_DIR = dirname(launcher.launcherPath);
  } catch (error) {
    console.error('[EV CLI] Unable to install launcher:', error);
  }
  const browserSkill = join(here, '../../../skills/ev-browser');

  const runtimes = new RuntimeRegistry([
    new PiRpcAdapter(),
    new CodexAppServerAdapter(),
    new ClaudeFamilyAdapter(CLAUDE_CODE_FLAVOR),
    new ClaudeFamilyAdapter(QODER_FLAVOR),
  ]);
  const agents = await AgentService.create(runtimes, {
    defaultWorkspace,
    legacyDefaultWorkspaces: [home],
    bundledSkillPaths: [browserSkill],
  });
  const management = new ManagementService(agents, defaultWorkspace, createAppearanceStore());
  const browserBridge = new BrowserBridgeService({ store: createBrowserBridgeStore() });
  try {
    await browserBridge.start();
  } catch {
    // 客户端可继续无浏览器集成运行。
  }
  const browserRuntimeDirectory = join(home, '.ev', 'run');
  await stopStandaloneBrowserHost(browserRuntimeDirectory);
  const mediaDownloads = new MediaDownloadService({
    downloadDirectory: join(home, 'Downloads', 'EV'),
  });
  const browserControlServer = new BrowserControlServer(
    new BrowserCommandExecutor(browserBridge, mediaDownloads),
    { runtimeDirectory: browserRuntimeDirectory }
  );
  try {
    await browserControlServer.start();
  } catch (error) {
    console.error('[EV Browser Control] Unable to start local CLI socket:', error);
  }

  const handlers = buildHandlers({ agents, management, browserBridge, broadcast });
  agents.setListener(task => broadcast('tasks:update', task));
  browserBridge.subscribe(snapshot => broadcast('browserBridge:update', snapshot));

  const dispatch = makeDispatcher(token, handlers);

  // dev 形态 renderer 跑在 vite origin（localhost:5173），跨域 fetch 需要 CORS；
  // 白名单仅 vite 默认口，prod 同源不依赖此头，安全口径不变。
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
  const buildHttpServer = (): ReturnType<typeof createServer> => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
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
          res.end(JSON.stringify(result.json ?? { error: result.text ?? '' }));
        });
      });
    });
    srv.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const wsToken = url.searchParams.get('token') ?? '';
      if (url.pathname !== '/ws' || !tokenTier(token, wsToken)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        sockets.add(ws as unknown as AbstractSocket);
        ws.on('close', () => sockets.delete(ws as unknown as AbstractSocket));
      });
    });
    return srv;
  };
  const httpServer = buildHttpServer();
  httpServer.listen(port, '127.0.0.1');
  // R1：remote 开启时加绑全部私网接口（LAN+Tailscale），绝不 0.0.0.0/公网；
  // 非 loopback 与 loopback 同样强制 token（/api 全接口 Bearer 校验）。
  let lanIps: string[] = [];
  let tailscaleIp: string | null = null;
  if (readRemoteEnabled()) {
    const found = privateInterfaces();
    lanIps = found.lan;
    tailscaleIp = found.tailscale[0] ?? null;
    for (const ip of [...lanIps, ...found.tailscale]) {
      buildHttpServer().listen(port, ip);
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
    lifecycle.clearServerInfo();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
