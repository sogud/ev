import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerInfo } from '@ev/contracts';
import { app, BrowserWindow, nativeTheme, shell } from 'electron';

/**
 * desktop = 窗壳 + server 监督（server-client-split-v1 / bb desktop 模式）。
 * 所有业务能力在 @ev/server；renderer 经 HTTP+WS 吃同一套契约，Electron IPC 层已删。
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
  // 解析序：打包 resources → dev dist-server；缺失时先构建（bun 仅构建工具）。
  if (app.isPackaged) return join(process.resourcesPath, 'server', 'server.mjs');
  return join(app.getAppPath(), 'dist-server', 'server.mjs');
}

function ensureEntryBuilt(entry: string): void {
  if (existsSync(entry)) return;
  const serverDir = join(app.getAppPath(), '../server');
  const built = spawnSync('bun', ['run', '--cwd', serverDir, 'build'], { stdio: 'ignore' });
  if (built.status !== 0 || !existsSync(entry)) {
    throw new Error(`server entry 构建失败：${entry}`);
  }
}

async function ensureServer(): Promise<ServerInfo> {
  const existing = readServerInfo();
  if (existing && isPidAlive(existing.pid) && (await healthOk(existing))) return existing;
  const entry = serverEntry();
  ensureEntryBuilt(entry);
  // 纯 Node 运行时口径：优先系统 node（better-sqlite3 原生绑定按系统 node ABI 构建）；
  // 无系统 node 时回退 Electron 自带 node（ELECTRON_RUN_AS_NODE），
  // 该路径需 pack 期按 Electron ABI 重编 better-sqlite3（见总结剩余风险）。
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
  throw new Error('EV server 启动超时');
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

  // UI 由 server 经 HTTP 服务（bb 模式，desktop 与 Web 同构）；
  // bootstrap 走 URL query，不是 IPC 通道。dev 可换 vite HMR 源。
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
  // 原生窗壳主题跟 server 记录走；renderer 自身主题应用不变。
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
  // server 常驻（herdr 模式）：关窗不杀 server，任务继续跑。
  app.quit();
});

app.on('before-quit', event => {
  if (cleanupStarted) return;
  cleanupStarted = true;
  event.preventDefault();
  app.quit();
});
