import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeDescriptor } from '@ev/contracts';

export type NativeAuth = NonNullable<RuntimeDescriptor['auth']>;

/**
 * 四家原生登录态只读探测（native-auth-display-v1）。
 * 路径以 2026-08-08 本机实测为准：
 * - pi：~/.pi/agent/auth.json（provider→凭据 的 dict，非空=已登录）
 * - codex：~/.codex/auth.json（tokens/OPENAI_API_KEY 存在=已登录）
 * - claude-code：macOS keychain 条目「Claude Code-credentials」（.credentials.json 本机不存在）
 * - qoder：~/.qoder/.auth/user（不透明加密文件，存在=已登录）
 * EV 只读不写；探测失败返回 unknown，不猜。
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
  const base = { configPaths: [authPath, settingsPath], hint: '运行 pi 并按提示完成原生认证' };
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
    hint: '运行 claude 并按提示完成原生认证（凭据在 macOS keychain）',
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
  const base = { configPaths: [authDir], hint: '运行 qodercli 并按提示完成原生认证' };
  try {
    const info = statSync(userFile);
    return info.size > 0 ? { status: 'logged_in', ...base } : { status: 'logged_out', ...base };
  } catch {
    return existsSync(userFile)
      ? { status: 'unknown', ...base }
      : { status: 'logged_out', ...base };
  }
}
