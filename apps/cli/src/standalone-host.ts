import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  BrowserBridgeService,
  BrowserCommandExecutor,
  BrowserControlServer,
  FileBrowserBridgeStore,
  MediaDownloadService,
  browserHostDiscoveryPath,
  browserHostIsAvailable,
  readBrowserHostDiscovery,
  removeStaleBrowserHost,
  standaloneBrowserHostIsAvailable,
  stopStandaloneBrowserHost,
} from '@ev/browser-host';

const HOST_START_TIMEOUT_MS = 5_000;
const DEFAULT_TRUSTED_EXTENSION_ORIGINS = [
  // projects/ 单层化后的 unpacked 路径 ID（旧 repos/ 路径 ID 保留兼容）
  'chrome-extension://cpjhgkmenplohfcnkpdlefojomngblon',
  'chrome-extension://klbmgfllmjipajbdcnmakapfchkhkdih',
];

function trustedExtensionOrigins(): string[] {
  const configured = (process.env.EV_BROWSER_EXTENSION_ORIGINS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const origins = [...DEFAULT_TRUSTED_EXTENSION_ORIGINS, ...configured];
  for (const origin of origins) {
    const url = new URL(origin);
    if (
      (url.protocol !== 'chrome-extension:' && url.protocol !== 'moz-extension:') ||
      !url.hostname ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.username ||
      url.password
    ) {
      throw new Error(`Invalid trusted EV Browser extension origin: ${origin}`);
    }
  }
  return [...new Set(origins)];
}

export function evHomeDirectory(): string {
  return process.env.EV_HOME?.trim() || path.join(os.homedir(), '.ev');
}

function runtimeDirectory(): string {
  return path.join(evHomeDirectory(), 'run');
}

export function standaloneDiscoveryPath(): string {
  return browserHostDiscoveryPath(runtimeDirectory());
}

function selfCommand(): { executable: string; args: string[] } {
  const script = process.argv[1];
  const usesScript = typeof script === 'string' && /\.(?:c|m)?(?:j|t)s$/.test(script);
  return {
    executable: process.execPath,
    args: [...(usesScript ? [script] : []), 'browser', 'host', '--background'],
  };
}

export async function ensureStandaloneHost(): Promise<boolean> {
  const runtimePath = runtimeDirectory();
  const existing = await readBrowserHostDiscovery(runtimePath);
  if (existing) {
    if (await browserHostIsAvailable(runtimePath, existing)) return false;
    await removeStaleBrowserHost(runtimePath, existing);
  }

  const command = selfCommand();
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + HOST_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    if (await standaloneBrowserHostIsAvailable(runtimePath)) return true;
  }
  throw new Error('Standalone Browser Host failed to start');
}

export async function runStandaloneHost(): Promise<void> {
  const home = evHomeDirectory();
  const configuredPort = Number(process.env.EV_BROWSER_BRIDGE_PORT ?? '43121');
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
    throw new Error('EV_BROWSER_BRIDGE_PORT must be an integer between 0 and 65535');
  }

  const bridge = new BrowserBridgeService({
    port: configuredPort,
    store: new FileBrowserBridgeStore(path.join(home, 'browser-host', 'pairing.json')),
    pairingMode: 'automatic',
    automaticPairingOrigins: trustedExtensionOrigins(),
  });
  const downloads = new MediaDownloadService({
    downloadDirectory:
      process.env.EV_DOWNLOAD_DIR?.trim() || path.join(os.homedir(), 'Downloads', 'EV'),
  });
  const commands = new BrowserCommandExecutor(bridge, downloads);
  let requestShutdown = (): void => {};
  const shutdownRequested = new Promise<void>(resolve => {
    requestShutdown = resolve;
  });
  const control = new BrowserControlServer(commands, {
    runtimeDirectory: runtimeDirectory(),
    hostKind: 'standalone',
    onShutdown: requestShutdown,
  });

  try {
    await bridge.start();
    await control.start();
  } catch (error) {
    await control.stop().catch(() => undefined);
    await bridge.stop().catch(() => undefined);
    throw error;
  }

  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);
  await shutdownRequested;
  await control.stop();
  await bridge.stop();
  downloads.dispose();
}

export async function stopStandaloneHost(): Promise<boolean> {
  return stopStandaloneBrowserHost(runtimeDirectory());
}
