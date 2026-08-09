import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeDescriptor } from '@ev/contracts';

export type NativeAuth = NonNullable<RuntimeDescriptor['auth']>;

/**
 * Read-only probes for the four native login states (native-auth-display-v1).
 * Paths verified on this machine on 2026-08-08:
 * - pi: ~/.pi/agent/auth.json (provider -> credential dict; non-empty = logged in)
 * - codex: ~/.codex/auth.json (tokens/OPENAI_API_KEY present = logged in)
 * - claude-code: macOS keychain entry "Claude Code-credentials"
 *   (.credentials.json does not exist locally)
 * - qoder: ~/.qoder/.auth/user (opaque encrypted file; present = logged in)
 * EV never writes these; a failed probe reports unknown instead of guessing.
 */

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function probePi(): NativeAuth {
  const authPath = join(homedir(), '.pi', 'agent', 'auth.json');
  const settingsPath = join(homedir(), '.pi', 'agent', 'settings.json');
  const base = {
    configPaths: [authPath, settingsPath],
    hint: 'Run pi and finish native auth as prompted',
  };
  const data = readJson(authPath);
  if (!data) {
    return existsSync(authPath)
      ? { status: 'unknown', ...base }
      : { status: 'logged_out', ...base };
  }
  const providers = Object.keys(data);
  return {
    status: providers.length > 0 ? 'logged_in' : 'logged_out',
    ...(providers.length > 0 ? { account: providers.join(', ') } : {}),
    ...base,
  };
}

export function probeCodex(): NativeAuth {
  const authPath = join(homedir(), '.codex', 'auth.json');
  const base = { configPaths: [authPath], loginCommand: 'codex login' };
  const data = readJson(authPath);
  if (!data) return { status: existsSync(authPath) ? 'unknown' : 'logged_out', ...base };
  const loggedIn = Boolean(data.tokens) || Boolean(data.OPENAI_API_KEY);
  return { status: loggedIn ? 'logged_in' : 'logged_out', ...base };
}

export async function probeClaude(): Promise<NativeAuth> {
  const base = {
    configPaths: [join(homedir(), '.claude')],
    hint: 'Run claude and finish native auth as prompted (credentials live in the macOS keychain)',
  };
  return await new Promise<NativeAuth>(resolve => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      { timeout: 5_000 },
      (error, stdout) => {
        if (!error) {
          const acct = /"acct"<blob>="([^"]*)"/.exec(stdout)?.[1];
          resolve({ status: 'logged_in', ...(acct ? { account: acct } : {}), ...base });
          return;
        }
        const message = String(error.message ?? error);
        resolve(
          message.includes('could not be found')
            ? { status: 'logged_out', ...base }
            : { status: 'unknown', ...base }
        );
      }
    );
  });
}

export function probeQoder(): NativeAuth {
  const authDir = join(homedir(), '.qoder', '.auth');
  const userFile = join(authDir, 'user');
  const base = { configPaths: [authDir], hint: 'Run qodercli and finish native auth as prompted' };
  try {
    const info = statSync(userFile);
    return info.size > 0 ? { status: 'logged_in', ...base } : { status: 'logged_out', ...base };
  } catch {
    return existsSync(userFile)
      ? { status: 'unknown', ...base }
      : { status: 'logged_out', ...base };
  }
}
