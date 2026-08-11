import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

/** EV_HOME overrides the data directory so tests/golden never touch the user's real store. */
function evDataDir(): string {
  return process.env.EV_HOME?.trim() || join(homedir(), '.ev');
}
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvClient, type EvClient } from '@ev/contracts/client';
import type { IssuedToken, ServerInfo } from '@ev/contracts';
import type { TaskDetail } from '@ev/contracts/domain';

/**
 * ev command tree: mirrors the contracts registry namespaces 1:1
 * (server-client-split-v1). Never imports @ev/server (the contract is the only
 * shared artifact); server.json reading is implemented locally against the
 * contract types.
 */

class CliError extends Error {}

let pretty = false;

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, undefined, pretty ? 2 : 0)}\n`);
}

function readServerInfo(): ServerInfo | null {
  try {
    const info = JSON.parse(readFileSync(join(evDataDir(), 'server.json'), 'utf8'));
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

function serverEntry(): string {
  if (process.env.EV_SERVER_ENTRY) return process.env.EV_SERVER_ENTRY;
  // packaged/built artifact first (pure Node); ensureServer builds it when missing.
  return join(dirname(fileURLToPath(import.meta.url)), '../../desktop/dist-server/server.mjs');
}

function ensureEntryBuilt(entry: string): void {
  if (existsSync(entry)) return;
  // pnpm is a build tool only; the server runtime is node.
  const serverDir = join(dirname(entry), '../../server');
  const built = spawnSync('pnpm', ['--dir', serverDir, 'run', 'build'], {
    stdio: 'ignore',
    shell: true,
  });
  if (built.status !== 0 || !existsSync(entry)) {
    throw new CliError(
      `server entry build failed: ${entry} (run pnpm --dir apps/server run build manually)`
    );
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

async function ensureServer(): Promise<ServerInfo> {
  const existing = readServerInfo();
  if (existing && isPidAlive(existing.pid) && (await healthOk(existing))) return existing;
  const entry = serverEntry();
  ensureEntryBuilt(entry);
  const child = spawn('node', [entry], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const info = readServerInfo();
    if (info && isPidAlive(info.pid) && (await healthOk(info))) return info;
  }
  throw new CliError('EV server start timed out');
}

async function client(): Promise<EvClient> {
  const info = await ensureServer();
  return createEvClient({ baseUrl: `http://127.0.0.1:${info.port}`, token: info.token });
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function tokensJsonPath(): string {
  return join(evDataDir(), 'tokens.json');
}

function readIssuedTokens(): IssuedToken[] {
  try {
    const raw = JSON.parse(readFileSync(tokensJsonPath(), 'utf8')) as { tokens?: IssuedToken[] };
    return Array.isArray(raw.tokens) ? raw.tokens : [];
  } catch {
    return [];
  }
}

function writeIssuedTokens(tokens: IssuedToken[]): void {
  writeFileSync(tokensJsonPath(), JSON.stringify({ tokens }, null, 2), { mode: 0o600 });
}

function createIssuedToken(tier: 'observer' | 'operator'): IssuedToken {
  const issued: IssuedToken = {
    id: randomBytes(4).toString('hex'),
    token: `evr_${randomBytes(24).toString('base64url')}`,
    tier,
    createdAt: Date.now(),
  };
  writeIssuedTokens([...readIssuedTokens(), issued]);
  return issued;
}

function revokeIssuedToken(id: string): boolean {
  const before = readIssuedTokens();
  const after = before.filter(item => item.id !== id);
  writeIssuedTokens(after);
  return after.length !== before.length;
}

/** Both remote URLs (LAN direct + Tailscale) plus the safety note; token masking is up to the caller. */
function remoteUrls(): {
  lanUrl: string | null;
  tailscaleUrl: string | null;
  note: string;
  webUrl(token: string): string;
} {
  const info = readServerInfo();
  const port = info?.port ?? 7877;
  const lan = info?.lanIps?.[0] ?? null;
  const ts = info?.tailscaleIp ?? null;
  const base = (ip: string): string => `http://${ip}:${port}/`;
  return {
    lanUrl: lan ? base(lan) : null,
    tailscaleUrl: ts ? base(ts) : null,
    note: 'Use Tailscale on untrusted WiFi; LAN is plain HTTP and only for trusted networks.',
    webUrl: (token: string): string => {
      const ip = ts ?? lan ?? '127.0.0.1';
      return `${base(ip)}?port=${port}&token=${token}`;
    },
  };
}

export async function runServerCli(argv: string[]): Promise<number> {
  pretty = argv.includes('--pretty');
  const args = argv.filter(value => value !== '--pretty');
  const [group, command, ...rest] = args;

  if (group === '--skill' || group === 'skill') {
    const skillPath =
      process.env.EV_SKILL_PATH ??
      join(dirname(fileURLToPath(import.meta.url)), '../../../skills/ev-browser/SKILL.md');
    process.stdout.write(readFileSync(skillPath, 'utf8'));
    return 0;
  }

  if (group === 'server') {
    if (command === 'status') {
      const info = readServerInfo();
      const alive = info ? isPidAlive(info.pid) && (await healthOk(info)) : false;
      out({
        running: alive,
        ...(info ? { port: info.port, pid: info.pid } : {}),
        ...(alive ? remoteUrls() : {}),
      });
      return 0;
    }
    if (command === 'start') {
      const info = await ensureServer();
      out({ running: true, port: info.port, pid: info.pid });
      return 0;
    }
    if (command === 'stop') {
      const info = readServerInfo();
      if (!info || !isPidAlive(info.pid)) {
        out({ running: false });
        return 0;
      }
      process.kill(info.pid, 'SIGTERM');
      out({ stopped: true });
      return 0;
    }
    throw new CliError('usage: ev server start|stop|status');
  }

  if (group === 'remote') {
    const remotePath = join(evDataDir(), 'remote.json');
    if (command === 'on' || command === 'off') {
      mkdirSync(dirname(remotePath), { recursive: true, mode: 0o700 });
      writeFileSync(remotePath, JSON.stringify({ enabled: command === 'on' }, null, 2), {
        mode: 0o600,
      });
      out({
        enabled: command === 'on',
        note: 'takes effect after a server restart: ev server stop && ev server start',
      });
      return 0;
    }
    if (command === 'status') {
      out(remoteUrls());
      return 0;
    }
    throw new CliError('usage: ev remote on|off|status');
  }

  if (group === 'token') {
    if (command === 'create') {
      const tier = flag(args, '--tier') ?? 'observer';
      if (tier !== 'observer' && tier !== 'operator')
        throw new CliError('--tier accepts observer|operator only');
      const issued = createIssuedToken(tier as 'observer' | 'operator');
      const urls = remoteUrls();
      out({
        id: issued.id,
        tier: issued.tier,
        token: issued.token,
        url: urls.webUrl(issued.token),
        note: 'observer is read-only; sending/mutating requires operator',
      });
      return 0;
    }
    if (command === 'list') {
      out(
        readIssuedTokens().map(item => ({
          id: item.id,
          tier: item.tier,
          createdAt: item.createdAt,
          token: `${item.token.slice(0, 8)}…`,
        }))
      );
      return 0;
    }
    if (command === 'revoke') {
      out({ revoked: revokeIssuedToken(rest[0]) });
      return 0;
    }
    throw new CliError('usage: ev token create --tier observer|operator | list | revoke <id>');
  }

  if (group === 'status') {
    const info = readServerInfo();
    const alive = info ? isPidAlive(info.pid) && (await healthOk(info)) : false;
    const urls = remoteUrls();
    const ip = info?.tailscaleIp ?? info?.lanIps?.[0] ?? '127.0.0.1';
    const port = info?.port ?? 7877;
    out({
      running: alive,
      ...(info ? { port: info.port, pid: info.pid } : {}),
      ...(alive
        ? {
            lanUrl: urls.lanUrl,
            tailscaleUrl: urls.tailscaleUrl,
            mobileUrlMasked: `http://${ip}:${port}/m/?port=${port}&token=<masked>`,
          }
        : {}),
      note: `${urls.note} The full token is printed once at ev token create time; list masks it; sending/mutating requires --tier operator.`,
    });
    return 0;
  }

  const api = await client();

  if (group === 'task') {
    if (command === 'list') {
      out(await api.tasks.list());
      return 0;
    }
    if (command === 'get') {
      out(await api.tasks.get(rest[0]));
      return 0;
    }
    if (command === 'create') {
      out(await api.tasks.create(flag(args, '--cwd'), flag(args, '--runtime') as never));
      return 0;
    }
    if (command === 'prompt') {
      out({ ok: await api.tasks.prompt(rest[0], rest.slice(1).join(' ')) });
      return 0;
    }
    if (command === 'abort') {
      out({ ok: await api.tasks.abort(rest[0]) });
      return 0;
    }
    if (command === 'remove') {
      out({ ok: await api.tasks.remove(rest[0]) });
      return 0;
    }
    if (command === 'set-runtime') {
      out({ ok: await api.tasks.setRuntime(rest[0], rest[1] as never) });
      return 0;
    }
    if (command === 'set-model') {
      out({ ok: await api.tasks.setModel(rest[0], rest[1], rest[2]) });
      return 0;
    }
    if (command === 'follow') {
      const id = rest[0];
      const untilIdle = args.includes('--until-idle');
      let seenAssistant = false;
      const initial = (await api.tasks.get(id)) as TaskDetail;
      let printed = initial.messages.length;
      for (const message of initial.messages) out(message);
      const hasAssistant = initial.messages.some(message => message.kind === 'assistant');
      if (untilIdle && hasAssistant && initial.status === 'idle') return 0;
      await new Promise<void>(resolve => {
        const stop = api.onWire('tasks:update', payload => {
          const detail = payload as TaskDetail;
          if (detail.id !== id) return;
          while (printed < detail.messages.length) {
            out(detail.messages[printed]);
            if (detail.messages[printed].kind === 'assistant') seenAssistant = true;
            printed += 1;
          }
          if (untilIdle && detail.status === 'error') {
            stop();
            out({ error: detail.error ?? 'task error' });
            process.exitCode = 1;
            resolve();
          }
          if (untilIdle && seenAssistant && detail.status === 'idle') {
            stop();
            resolve();
          }
        });
      });
      api.close();
      return 0;
    }
    throw new CliError(
      'usage: ev task list|get|create|prompt|abort|remove|set-runtime|set-model|follow'
    );
  }

  if (group === 'runtime') {
    if (command === 'list') {
      out(await api.runtimes.list());
      return 0;
    }
    throw new CliError('usage: ev runtime list');
  }

  if (group === 'provider') {
    if (command === 'list') {
      out(await api.providers.list());
      return 0;
    }
    // read-only (native-auth-display-v1): login always happens in the runtime itself.
    throw new CliError("usage: ev provider list (log in via each runtime's native command)");
  }

  if (group === 'inspection') {
    if (command === 'get') {
      out(await api.inspection.get(rest[0]));
      return 0;
    }
    throw new CliError('usage: ev inspection get <taskId>');
  }

  if (group === 'settings') {
    if (command === 'get') {
      out(await api.settings.get());
      return 0;
    }
    if (command === 'set') {
      let input: Parameters<typeof api.settings.update>[0];
      try {
        input = JSON.parse(rest.join(' '));
      } catch {
        throw new CliError('ev settings set requires valid JSON');
      }
      out(await api.settings.update(input));
      return 0;
    }
    throw new CliError('usage: ev settings get|set <json>');
  }

  throw new CliError(
    `unknown command group: ${group} (task/runtime/provider/inspection/settings/server/browser/--skill)`
  );
}

export function isServerCliCommand(argv: string[]): boolean {
  return [
    'task',
    'runtime',
    'provider',
    'inspection',
    'settings',
    'token',
    'remote',
    'status',
    'server',
    '--skill',
    'skill',
  ].includes(argv[0] ?? '');
}

export { CliError };
