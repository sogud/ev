import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerInfo } from '@ev/contracts';
import { app, BrowserWindow, nativeTheme, shell } from 'electron';

/**
 * desktop = window shell + server supervisor (server-client-split-v1 / bb desktop mode).
 * All product capabilities live in @ev/server; the renderer consumes the same contract
 * over HTTP+WS. The Electron IPC layer is gone.
 */

let cleanupStarted = false;

app.setName('EV');

function readServerInfo(): ServerInfo | null {
  try {
    const info = JSON.parse(readFileSync(join(homedir(), '.ev', 'server.json'), 'utf8'));
    return typeof info?.port === 'number' && typeof info?.token === 'string'
      ? (info as ServerInfo)
      : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthOk(info: ServerInfo): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function serverEntry(): string {
  if (process.env.EV_SERVER_ENTRY) return process.env.EV_SERVER_ENTRY;
  // Resolution order: packaged resources -> dev dist-server; build first when missing (pnpm is build tooling only).
  if (app.isPackaged) return join(process.resourcesPath, 'server', 'server.mjs');
  return join(app.getAppPath(), 'dist-server', 'server.mjs');
}

function ensureEntryBuilt(entry: string): void {
  if (existsSync(entry)) return;
  const serverDir = join(app.getAppPath(), '../server');
  const built = spawnSync('pnpm', ['--dir', serverDir, 'run', 'build'], {
    stdio: 'ignore',
    shell: true,
  });
  if (built.status !== 0 || !existsSync(entry)) {
    throw new Error(`Failed to build server entry: ${entry}`);
  }
}

async function ensureServer(): Promise<ServerInfo> {
  const existing = readServerInfo();
  if (existing && isPidAlive(existing.pid) && (await healthOk(existing))) return existing;
  const entry = serverEntry();
  ensureEntryBuilt(entry);
  // Runtime policy: prefer the system node (better-sqlite3 native bindings are built against
  // the system node ABI); fall back to Electron-bundled node (ELECTRON_RUN_AS_NODE), which
  // requires rebuilding better-sqlite3 against the Electron ABI at pack time.
  const hasNode = spawnSync('node', ['--version'], { stdio: 'ignore' }).status === 0;
  const child = hasNode
    ? spawn('node', [entry], { detached: true, stdio: 'ignore' })
    : spawn(process.execPath, [entry], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const info = readServerInfo();
    if (info && isPidAlive(info.pid) && (await healthOk(info))) return info;
  }
  throw new Error('EV server start timed out');
}

function createWindow(info: ServerInfo): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#f7f7f8',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 22 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The UI is served by the server over HTTP (bb mode; desktop and web are isomorphic);
  // bootstrap reads the URL query, not an IPC channel. Dev can swap in the vite HMR source.
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(
      `${process.env.ELECTRON_RENDERER_URL}/#port=${info.port}&token=${encodeURIComponent(info.token)}`
    );
  } else {
    void window.loadURL(
      `http://127.0.0.1:${info.port}/?port=${info.port}&token=${encodeURIComponent(info.token)}`
    );
  }
  return window;
}

app.whenReady().then(async () => {
  const info = await ensureServer();
  // The native shell theme follows the server record; the renderer applies it itself.
  try {
    const settings = await (
      await fetch(`http://127.0.0.1:${info.port}/api/settings/get`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${info.token}`,
          'content-type': 'application/json',
        },
        body: '{"args":[]}',
      })
    ).json();
    nativeTheme.themeSource = (settings?.theme as 'system' | 'light' | 'dark') ?? 'system';
  } catch {
    nativeTheme.themeSource = 'system';
  }
  createWindow(info);
});

app.on('window-all-closed', () => {
  // The server is resident: closing the window does not kill it, tasks keep running.
  app.quit();
});

app.on('before-quit', event => {
  if (cleanupStarted) return;
  cleanupStarted = true;
  event.preventDefault();
  app.quit();
});
