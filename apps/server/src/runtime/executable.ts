import { execFile } from 'node:child_process';
import { constants, readdirSync } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function resolveExecutable(
  name: string,
  environmentVariable: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const configured = environment[environmentVariable]?.trim();
  const candidates = [
    configured,
    ...(environment.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map(directory => path.join(directory, name)),
    path.join(os.homedir(), '.npm-global', 'bin', name),
    path.join(os.homedir(), '.local', 'bin', name),
    path.join('/opt/homebrew/bin', name),
    path.join('/usr/local/bin', name),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the fixed candidate list.
    }
  }
  return null;
}

function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/, '').split('.').map(Number);
  const right = b.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function fallbackPathEntries(home: string): string[] {
  const entries = [
    path.dirname(process.execPath),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  try {
    const versions = readdirSync(path.join(home, '.nvm', 'versions', 'node'))
      .filter(name => /^v\d+(\.\d+)*$/.test(name))
      .sort(compareVersions);
    const latest = versions[versions.length - 1];
    if (latest) entries.unshift(path.join(home, '.nvm', 'versions', 'node', latest, 'bin'));
  } catch {
    // nvm is optional.
  }
  return entries;
}

function loginShell(environment: NodeJS.ProcessEnv): string | null {
  if (process.platform === 'win32') return null;
  const fromEnvironment = environment.SHELL?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    return os.userInfo().shell || null;
  } catch {
    return null;
  }
}

let userPathCache: Promise<string | null> | null = null;

export function resetUserPathCache(): void {
  userPathCache = null;
}

/**
 * Detect the PATH the user actually has in a terminal by asking their login shell.
 * This is the same approach VS Code uses to fix the minimal macOS GUI environment,
 * and it automatically covers nvm, volta, Homebrew, npm prefixes, and rc-file tools.
 */
export function detectUserPath(
  environment: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (!userPathCache) {
    userPathCache = (async () => {
      const shell = loginShell(environment);
      if (!shell) return null;
      try {
        const { stdout } = await execFileAsync(shell, ['-ilc', 'printf %s "$PATH"'], {
          timeout: 4_000,
          env: environment,
        });
        const value = stdout
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
          .pop();
        return value && value.includes(path.delimiter) ? value : null;
      } catch {
        return null;
      }
    })();
  }
  return userPathCache;
}

/**
 * macOS GUI apps receive a minimal PATH, so shebang CLIs such as `#!/usr/bin/env node`
 * fail with `env: node: No such file or directory`. Runtime children therefore get the
 * user's login-shell PATH when detectable, plus a fixed fallback list.
 */
export async function runtimeChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> {
  const home = environment.HOME ?? os.homedir();
  const detected = (await detectUserPath(environment)) ?? '';
  const merged = [
    ...detected.split(path.delimiter).filter(Boolean),
    ...(environment.PATH ?? '').split(path.delimiter).filter(Boolean),
    ...fallbackPathEntries(home),
  ];
  return { ...environment, PATH: [...new Set(merged)].join(path.delimiter) };
}

/**
 * Single entry point for runtime child env: login-shell PATH + fixed fallback +
 * the EV launcher dir. index.ts writes EV_CLI_BIN_DIR at startup (a configured
 * value, not a child-env leak); adapters and lifecycle consume it instead of
 * assembling PATH themselves.
 */
export async function launchEnvironment(
  base: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> {
  return runtimeChildEnvironment({
    ...base,
    PATH: [base.EV_CLI_BIN_DIR, base.PATH].filter(Boolean).join(path.delimiter),
  });
}
