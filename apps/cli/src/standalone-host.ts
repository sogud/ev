import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
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

export function evHomeDirectory(): string {
  return process.env.EV_HOME?.trim() || path.join(os.homedir(), '.ev');
}

// --- Browser profiles -------------------------------------------------------
// A profile is one Host + one paired browser. The default profile keeps the
// historical paths; named profiles get isolated runtime/pairing locations and
// their own bridge port, so several browsers (Chrome, Edge, ...) can each run
// a Host without colliding.

export const DEFAULT_BROWSER_PROFILE = 'default';
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DEFAULT_BRIDGE_PORT = 43121;

export function normalizeBrowserProfile(profile: string | undefined): string {
  const name = profile?.trim() || DEFAULT_BROWSER_PROFILE;
  if (name !== DEFAULT_BROWSER_PROFILE && !PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      'profile must match [a-z0-9][a-z0-9_-]{0,31} (lowercase letters, digits, - or _)'
    );
  }
  return name;
}

function runtimeDirectory(): string {
  return path.join(evHomeDirectory(), 'run');
}

export function profileRuntimeDirectory(profile: string): string {
  const name = normalizeBrowserProfile(profile);
  return name === DEFAULT_BROWSER_PROFILE
    ? runtimeDirectory()
    : path.join(runtimeDirectory(), 'profiles', name);
}

export function profilePairingPath(profile: string): string {
  const name = normalizeBrowserProfile(profile);
  const home = evHomeDirectory();
  return name === DEFAULT_BROWSER_PROFILE
    ? path.join(home, 'browser-host', 'pairing.json')
    : path.join(home, 'browser-host', 'profiles', name, 'pairing.json');
}

interface ProfileRegistry {
  [name: string]: { port: number };
}

function profilesRegistryPath(): string {
  return path.join(evHomeDirectory(), 'browser-host', 'profiles.json');
}

async function readProfileRegistry(): Promise<ProfileRegistry> {
  try {
    const decoded = JSON.parse(await readFile(profilesRegistryPath(), 'utf8')) as unknown;
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
      return decoded as ProfileRegistry;
    }
  } catch {
    // missing or corrupt registry: start fresh
  }
  return {};
}

async function writeProfileRegistry(registry: ProfileRegistry): Promise<void> {
  await writeFile(profilesRegistryPath(), JSON.stringify(registry, null, 2), { mode: 0o600 });
}

/** True when nothing is listening on 127.0.0.1:<port> right now. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen({ port, host: '127.0.0.1' });
  });
}

/** First free port >= preferred, skipping reserved registry ports unless allowed. */
async function findFreePort(preferred: number, reserved: Set<number>): Promise<number> {
  let port = preferred;
  while (port <= 65_535) {
    if (!reserved.has(port) && (await isPortFree(port))) return port;
    port += 1;
  }
  throw new Error('no free local port available for the Browser Host bridge');
}

/**
 * Bridge port for a profile. Default honors EV_BROWSER_BRIDGE_PORT; named
 * profiles get a stable auto-assigned port (43122+) persisted in the registry.
 * Assignment probes 127.0.0.1 so a port held by another app is skipped; if a
 * persisted port is taken at host start, runStandaloneHost re-assigns it.
 */
export async function profileBridgePort(profile: string): Promise<number> {
  const name = normalizeBrowserProfile(profile);
  if (name === DEFAULT_BROWSER_PROFILE) {
    const configured = Number(process.env.EV_BROWSER_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);
    if (!Number.isInteger(configured) || configured < 0 || configured > 65_535) {
      throw new Error('EV_BROWSER_BRIDGE_PORT must be an integer between 0 and 65535');
    }
    return configured;
  }
  const registry = await readProfileRegistry();
  const existing = registry[name]?.port;
  if (Number.isInteger(existing) && existing > 0 && existing <= 65_535) return existing;
  const reserved = new Set(
    Object.values(registry)
      .map(entry => entry?.port)
      .filter((port): port is number => Number.isInteger(port))
  );
  reserved.add(DEFAULT_BRIDGE_PORT);
  const port = await findFreePort(DEFAULT_BRIDGE_PORT + 1, reserved);
  registry[name] = { port };
  await writeProfileRegistry(registry);
  return port;
}

export interface BrowserProfileInfo {
  profile: string;
  port: number;
  hostOnline: boolean;
  pairedBrowsers: Array<{ origin: string; browserId: string }>;
}

/** Snapshot of every known profile (default + registered) for `ev browser profile list`. */
export async function listBrowserProfiles(): Promise<BrowserProfileInfo[]> {
  const registry = await readProfileRegistry();
  const names = [DEFAULT_BROWSER_PROFILE, ...Object.keys(registry).sort()];
  const infos: BrowserProfileInfo[] = [];
  for (const name of names) {
    const runtime = profileRuntimeDirectory(name);
    let hostOnline = false;
    const discovery = await readBrowserHostDiscovery(runtime);
    if (discovery) hostOnline = await browserHostIsAvailable(runtime, discovery);
    const pairedBrowsers: Array<{ origin: string; browserId: string }> = [];
    try {
      const pairing = JSON.parse(await readFile(profilePairingPath(name), 'utf8')) as Record<
        string,
        unknown
      >;
      // Current multi-identity shape; the legacy single-identity file is
      // migrated by FileBrowserBridgeStore on first write.
      if (Array.isArray(pairing.identities)) {
        for (const identity of pairing.identities) {
          if (
            identity &&
            typeof identity === 'object' &&
            typeof identity.allowedOrigin === 'string' &&
            typeof identity.browserId === 'string'
          ) {
            pairedBrowsers.push({ origin: identity.allowedOrigin, browserId: identity.browserId });
          }
        }
      } else if (
        typeof pairing.allowedOrigin === 'string' &&
        typeof pairing.browserId === 'string'
      ) {
        pairedBrowsers.push({ origin: pairing.allowedOrigin, browserId: pairing.browserId });
      }
    } catch {
      // never paired
    }
    infos.push({
      profile: name,
      port: await profileBridgePort(name),
      hostOnline,
      pairedBrowsers,
    });
  }
  return infos;
}

export function standaloneDiscoveryPath(profile: string = DEFAULT_BROWSER_PROFILE): string {
  return browserHostDiscoveryPath(profileRuntimeDirectory(profile));
}

function selfCommand(profile: string): { executable: string; args: string[] } {
  const script = process.argv[1];
  const usesScript = typeof script === 'string' && /\.(?:c|m)?(?:j|t)s$/.test(script);
  return {
    executable: process.execPath,
    args: [
      ...(usesScript ? [script] : []),
      'browser',
      'host',
      '--background',
      ...(profile === DEFAULT_BROWSER_PROFILE ? [] : ['--profile', profile]),
    ],
  };
}

export async function ensureStandaloneHost(
  profile: string = DEFAULT_BROWSER_PROFILE
): Promise<boolean> {
  const name = normalizeBrowserProfile(profile);
  const runtimePath = profileRuntimeDirectory(name);
  const existing = await readBrowserHostDiscovery(runtimePath);
  if (existing) {
    if (await browserHostIsAvailable(runtimePath, existing)) return false;
    await removeStaleBrowserHost(runtimePath, existing);
  }

  const command = selfCommand(name);
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
  throw new Error(`Standalone Browser Host failed to start (profile: ${name})`);
}

export async function runStandaloneHost(profile: string = DEFAULT_BROWSER_PROFILE): Promise<void> {
  const name = normalizeBrowserProfile(profile);
  let port = await profileBridgePort(name);
  // The persisted profile port can be squatted by another app between boots;
  // move to the next free port and update the registry so the extension
  // endpoint stays deterministic.
  if (name !== DEFAULT_BROWSER_PROFILE && !(await isPortFree(port))) {
    const registry = await readProfileRegistry();
    const reserved = new Set(
      Object.entries(registry)
        .filter(([key]) => key !== name)
        .map(([, entry]) => entry?.port)
        .filter((value): value is number => Number.isInteger(value))
    );
    reserved.add(DEFAULT_BRIDGE_PORT);
    port = await findFreePort(port + 1, reserved);
    registry[name] = { port };
    await writeProfileRegistry(registry);
    console.error(`[EV] profile "${name}" port was busy; moved to ${port}`);
  }

  // Pairing is per-browser and needs one explicit approval: any local
  // chrome-extension origin may *request* pairing, but nothing is trusted
  // until `ev browser pairing approve <browser-id>` accepts it. The extension
  // stores the issued pairing token, so reloads, rebuilds and Host restarts
  // reconnect without another prompt. Pinning extension ids would break every
  // build loaded from a new machine or directory — exactly what the old
  // hardcoded allowlist did.
  const bridge = new BrowserBridgeService({
    port,
    store: new FileBrowserBridgeStore(profilePairingPath(name)),
    pairingMode: 'approval',
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
  const control = new BrowserControlServer(
    {
      sendCommand: commands.sendCommand.bind(commands),
      getSnapshot: bridge.getSnapshot.bind(bridge),
      approvePendingPairing: bridge.approvePendingPairing.bind(bridge),
      rejectPendingPairing: bridge.rejectPendingPairing.bind(bridge),
    },
    {
      runtimeDirectory: profileRuntimeDirectory(name),
      hostKind: 'standalone',
      onShutdown: requestShutdown,
    }
  );

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

export async function stopStandaloneHost(
  profile: string = DEFAULT_BROWSER_PROFILE
): Promise<boolean> {
  return stopStandaloneBrowserHost(profileRuntimeDirectory(normalizeBrowserProfile(profile)));
}
