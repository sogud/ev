import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const servers: net.Server[] = [];

async function runCli(
  args: string[],
  environment: NodeJS.ProcessEnv
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const cliDir = path.resolve(import.meta.dirname, '..');
  const distEntry = path.join(cliDir, 'dist', 'ev.js');
  if (!existsSync(distEntry)) {
    // bun 仅构建工具；CLI 运行时为 node（修订口径）。
    const built = spawnSync('bun', ['run', 'build'], { cwd: cliDir, stdio: 'ignore' });
    if (built.status !== 0) throw new Error('cli build failed');
  }
  const child = spawn('node', [distEntry, ...args], {
    cwd: cliDir,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  );
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })));
});

describe('ev browser CLI', () => {
  it('sends a validated action through the Desktop discovery socket', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-cli-'));
    directories.push(directory);
    const socketPath = path.join(directory, 'browser.sock');
    const tokenPath = path.join(directory, 'browser.token');
    const discoveryPath = path.join(directory, 'browser-control.json');
    const token = 't'.repeat(43);
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);

    const server = net.createServer(socket => {
      socket.setEncoding('utf8');
      let input = '';
      socket.on('data', chunk => {
        input += chunk;
        if (!input.includes('\n')) return;
        const request = JSON.parse(input.slice(0, input.indexOf('\n')));
        expect(request).toMatchObject({
          token,
          command: { action: 'page.snapshot', tabId: 7, mode: 'interactive' },
        });
        socket.end(
          `${JSON.stringify({
            requestId: request.requestId,
            success: true,
            data: { tabId: 7, nodes: [{ ref: '@e1', role: 'button', name: 'Save' }] },
          })}\n`
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await writeFile(discoveryPath, JSON.stringify({ protocolVersion: 1, socketPath, tokenPath }));

    const { exitCode, stdout, stderr } = await runCli(
      [
        'browser',
        'page.snapshot',
        '--payload',
        JSON.stringify({ tabId: 7, mode: 'interactive' }),
        '--compact',
      ],
      { ...process.env, EV_BROWSER_CONTROL_FILE: discoveryPath }
    );

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      tabId: 7,
      nodes: [{ ref: '@e1', role: 'button', name: 'Save' }],
    });
  });

  it('auto-starts a standalone Browser Host when Desktop is absent', async () => {
    const evHome = await mkdtemp(path.join(os.tmpdir(), 'ev-standalone-'));
    directories.push(evHome);

    const result = await runCli(['browser', 'check', '--compact'], {
      ...process.env,
      EV_HOME: evHome,
      EV_BROWSER_BRIDGE_PORT: '0',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('BROWSER_DISCONNECTED');
    const discovery = JSON.parse(
      await readFile(path.join(evHome, 'run', 'browser-control.json'), 'utf8')
    );
    expect(discovery).toMatchObject({ hostKind: 'standalone' });

    const stopped = await runCli(['browser', 'host', 'stop'], {
      ...process.env,
      EV_HOME: evHome,
    });
    expect(stopped.exitCode).toBe(0);
  }, 20_000);

  it('replaces stale Desktop discovery with a standalone Browser Host', async () => {
    const evHome = await mkdtemp(path.join(os.tmpdir(), 'ev-stale-desktop-'));
    directories.push(evHome);
    const runtimeDirectory = path.join(evHome, 'run');
    const tokenPath = path.join(runtimeDirectory, 'stale.token');
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(tokenPath, `${'t'.repeat(43)}\n`);
    await writeFile(
      path.join(runtimeDirectory, 'browser-control.json'),
      JSON.stringify({
        protocolVersion: 1,
        socketPath: path.join(runtimeDirectory, 'stale.sock'),
        tokenPath,
        hostKind: 'desktop',
        pid: process.pid,
      })
    );

    const result = await runCli(['browser', 'check', '--compact'], {
      ...process.env,
      EV_HOME: evHome,
      EV_BROWSER_BRIDGE_PORT: '0',
    });

    expect(result.stderr).toContain('BROWSER_DISCONNECTED');
    const discovery = JSON.parse(
      await readFile(path.join(runtimeDirectory, 'browser-control.json'), 'utf8')
    );
    expect(discovery).toMatchObject({ hostKind: 'standalone' });
    await runCli(['browser', 'host', 'stop'], { ...process.env, EV_HOME: evHome });
  }, 20_000);

  it('rejects arbitrary eval before connecting to Desktop', async () => {
    const { exitCode, stderr } = await runCli(
      ['browser', 'page.eval', '--payload', '{"expression":"document.cookie"}'],
      { ...process.env, EV_BROWSER_CONTROL_FILE: path.join(os.tmpdir(), randomUUID()) }
    );

    expect(exitCode).toBe(2);
    expect(stderr).toContain('不支持或参数无效的浏览器 action');
  });
});
