import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerInfo } from '@ev/contracts';

/** ~/.ev/server.json: the only discovery entry for clients (herdr mode). */
export function serverJsonPath(): string {
  return join(homedir(), '.ev', 'server.json');
}

export function readServerInfo(): ServerInfo | null {
  try {
    const raw = readFileSync(serverJsonPath(), 'utf8');
    const info = JSON.parse(raw) as ServerInfo;
    if (typeof info.port !== 'number' || typeof info.token !== 'string') return null;
    return info;
  } catch {
    return null;
  }
}

export function writeServerInfo(info: ServerInfo): void {
  const dir = join(homedir(), '.ev');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(serverJsonPath(), JSON.stringify(info, null, 2), { mode: 0o600 });
}

export function clearServerInfo(): void {
  try {
    unlinkSync(serverJsonPath());
  } catch {
    // gone already: ignore.
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Liveness probe: server.json exists and its pid is alive. */
export function runningServerInfo(): ServerInfo | null {
  const info = readServerInfo();
  if (!info) return null;
  return isPidAlive(info.pid) ? info : null;
}

export function ensureExists<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected value');
  return value;
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
