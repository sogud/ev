import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const directories: string[] = [];
const servers: net.Server[] = [];
const cliDir = path.resolve(import.meta.dirname, '..');
const distEntry = path.join(cliDir, 'dist', 'ev.js');

function parseJson(value: string): ReturnType<typeof JSON.parse> {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error('Expected valid JSON in CLI test', { cause: error });
  }
}

beforeAll(async () => {
  await mkdir(path.dirname(distEntry), { recursive: true });
  await build({
    entryPoints: [path.join(cliDir, 'src', 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: 'import { createRequire as __evCjsRequire } from "node:module"; const require = __evCjsRequire(import.meta.url);',
    },
    outfile: distEntry,
  });
});

async function runCli(
  args: string[],
  environment: NodeJS.ProcessEnv
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
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
  const trash = path.join(os.homedir(), '.Trash');
  await mkdir(trash, { recursive: true });
  await Promise.all(
    directories
      .splice(0)
      .map(directory =>
        rename(directory, path.join(trash, `${path.basename(directory)}-${randomUUID()}`))
      )
  );
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
        const request = parseJson(input.slice(0, input.indexOf('\n')));
        expect(request).toMatchObject({
          token,
          command: {
            action: 'browser.session.command',
            sessionId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
            command: { action: 'page.snapshot', mode: 'interactive' },
          },
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
        'session.command',
        '--payload',
        JSON.stringify({
          sessionId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
          command: { action: 'page.snapshot', mode: 'interactive' },
        }),
        '--compact',
      ],
      { ...process.env, EV_BROWSER_CONTROL_FILE: discoveryPath }
    );

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(parseJson(stdout)).toEqual({
      tabId: 7,
      nodes: [{ ref: '@e1', role: 'button', name: 'Save' }],
    });
  });

  it('submits browser.run plans and prints only the final result', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-cli-run-'));
    directories.push(directory);
    const socketPath = path.join(directory, 'browser.sock');
    const tokenPath = path.join(directory, 'browser.token');
    const discoveryPath = path.join(directory, 'browser-control.json');
    const token = 't'.repeat(43);
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });

    const server = net.createServer(socket => {
      socket.setEncoding('utf8');
      let input = '';
      socket.on('data', chunk => {
        input += chunk;
        if (!input.includes('\n')) return;
        const request = parseJson(input.slice(0, input.indexOf('\n')));
        expect(request.command).toEqual({
          action: 'browser.session.command',
          sessionId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
          command: {
            action: 'browser.run',
            steps: [{ kind: 'wait', timeMs: 0 }],
          },
        });
        socket.end(
          `${JSON.stringify({
            requestId: request.requestId,
            success: true,
            data: {
              sessionId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
              tabId: 11,
              result: {
                runId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
                status: 'completed',
                summary: { commands: 0, iterations: 0, retries: 0, durationMs: 1 },
                failures: [],
              },
            },
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

    const result = await runCli(
      [
        'browser',
        'session.command',
        '--payload',
        JSON.stringify({
          sessionId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
          command: { action: 'browser.run', steps: [{ kind: 'wait', timeMs: 0 }] },
        }),
        '--compact',
      ],
      { ...process.env, EV_BROWSER_CONTROL_FILE: discoveryPath }
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(parseJson(result.stdout)).toEqual({
      sessionId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
      tabId: 11,
      result: {
        runId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
        status: 'completed',
        summary: { commands: 0, iterations: 0, retries: 0, durationMs: 1 },
        failures: [],
      },
    });
  });

  it('maps session and recipe aliases to Browser Host commands', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-cli-session-'));
    directories.push(directory);
    const socketPath = path.join(directory, 'browser.sock');
    const tokenPath = path.join(directory, 'browser.token');
    const discoveryPath = path.join(directory, 'browser-control.json');
    const token = 't'.repeat(43);
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });

    const server = net.createServer(socket => {
      socket.setEncoding('utf8');
      let input = '';
      socket.on('data', chunk => {
        input += chunk;
        if (!input.includes('\n')) return;
        const request = parseJson(input.slice(0, input.indexOf('\n')));
        if (request.command.action === 'browser.recipe.list') {
          socket.end(
            `${JSON.stringify({
              requestId: request.requestId,
              success: true,
              data: { recipes: [{ id: 'x.mute-words', status: 'approved' }] },
            })}\n`
          );
          return;
        }
        expect(request.command).toEqual({
          action: 'browser.session.create',
          url: 'https://example.com',
        });
        socket.end(
          `${JSON.stringify({
            requestId: request.requestId,
            success: true,
            data: {
              sessionId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
              windowId: 9,
              groupId: 20,
              ownedTabIds: [11],
              activeTabId: 11,
            },
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

    const result = await runCli(
      ['browser', 'session.create', '--payload', '{"url":"https://example.com"}', '--compact'],
      { ...process.env, EV_BROWSER_CONTROL_FILE: discoveryPath }
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(parseJson(result.stdout)).toMatchObject({
      windowId: 9,
      groupId: 20,
      ownedTabIds: [11],
    });

    const recipes = await runCli(['browser', 'recipe.list', '--compact'], {
      ...process.env,
      EV_BROWSER_CONTROL_FILE: discoveryPath,
    });
    expect(recipes).toMatchObject({ exitCode: 0, stderr: '' });
    expect(parseJson(recipes.stdout)).toEqual({
      recipes: [{ id: 'x.mute-words', status: 'approved' }],
    });
  });

  it('writes a scoped BrowserSession screenshot without printing base64', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-cli-screenshot-'));
    directories.push(directory);
    const socketPath = path.join(directory, 'browser.sock');
    const tokenPath = path.join(directory, 'browser.token');
    const discoveryPath = path.join(directory, 'browser-control.json');
    const outputPath = path.join(directory, 'screenshots', 'page.png');
    const token = 't'.repeat(43);
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });

    const server = net.createServer(socket => {
      socket.setEncoding('utf8');
      let input = '';
      socket.on('data', chunk => {
        input += chunk;
        if (!input.includes('\n')) return;
        const request = parseJson(input.slice(0, input.indexOf('\n')));
        expect(request.command).toEqual({
          action: 'browser.session.command',
          sessionId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
          command: { action: 'page.screenshot', fullPage: false },
        });
        socket.end(
          `${JSON.stringify({
            requestId: request.requestId,
            success: true,
            data: {
              sessionId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
              tabId: 11,
              result: {
                tabId: 11,
                format: 'png',
                data: Buffer.from('png-bytes').toString('base64'),
                fullPage: false,
              },
            },
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

    const result = await runCli(
      [
        'browser',
        'session.command',
        '--payload',
        JSON.stringify({
          sessionId: '3f88e635-1ba1-4e8c-91fd-83d682959f8a',
          command: { action: 'page.screenshot', fullPage: false },
        }),
        '--output',
        outputPath,
        '--compact',
      ],
      { ...process.env, EV_BROWSER_CONTROL_FILE: discoveryPath }
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await readFile(outputPath, 'utf8')).toBe('png-bytes');
    expect(parseJson(result.stdout)).toEqual({
      tabId: 11,
      format: 'png',
      fullPage: false,
      outputPath,
    });
    expect(result.stdout).not.toContain('cG5nLWJ5dGVz');
  });

  it('writes bookmark exports and automatically backs up before bookmark mutations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-cli-bookmarks-'));
    directories.push(directory);
    const socketPath = path.join(directory, 'browser.sock');
    const tokenPath = path.join(directory, 'browser.token');
    const discoveryPath = path.join(directory, 'browser-control.json');
    const outputPath = path.join(directory, 'manual', 'bookmarks.json');
    const token = 't'.repeat(43);
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });

    const commands: string[] = [];
    const server = net.createServer(socket => {
      socket.setEncoding('utf8');
      let input = '';
      socket.on('data', chunk => {
        input += chunk;
        if (!input.includes('\n')) return;
        const request = parseJson(input.slice(0, input.indexOf('\n')));
        commands.push(request.command.action);
        if (request.command.action === 'bookmarks.remove') {
          socket.end(
            `${JSON.stringify({
              requestId: request.requestId,
              success: false,
              error: { code: 'BOOKMARK_REMOVE_FAILED', message: 'cannot remove bookmark' },
            })}\n`
          );
          return;
        }
        const data =
          request.command.action === 'bookmarks.export'
            ? {
                exportedAt: '2026-08-13T12:00:00.000Z',
                tree: [
                  {
                    title: 'Bookmarks bar',
                    children: [{ title: 'EV docs', url: 'https://ev.dev' }],
                  },
                ],
              }
            : { id: '42', title: 'New bookmark', url: 'https://example.com' };
        socket.end(`${JSON.stringify({ requestId: request.requestId, success: true, data })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await writeFile(discoveryPath, JSON.stringify({ protocolVersion: 1, socketPath, tokenPath }));

    const environment = {
      ...process.env,
      EV_HOME: directory,
      EV_BROWSER_CONTROL_FILE: discoveryPath,
    };
    const exported = await runCli(
      ['browser', 'bookmarks.export', '--output', outputPath, '--compact'],
      environment
    );
    expect(exported).toMatchObject({ exitCode: 0, stderr: '' });
    expect(parseJson(await readFile(outputPath, 'utf8'))).toEqual({
      exportedAt: '2026-08-13T12:00:00.000Z',
      tree: [
        {
          title: 'Bookmarks bar',
          children: [{ title: 'EV docs', url: 'https://ev.dev' }],
        },
      ],
    });

    const created = await runCli(
      [
        'browser',
        'bookmarks.create',
        '--payload',
        JSON.stringify({ title: 'New bookmark', url: 'https://example.com' }),
        '--compact',
      ],
      environment
    );
    expect(created).toMatchObject({ exitCode: 0, stderr: '' });
    const result = parseJson(created.stdout);
    expect(result).toMatchObject({ id: '42', title: 'New bookmark' });
    expect(result.backupPath).toContain(path.join('backups', 'bookmarks'));
    expect(parseJson(await readFile(result.backupPath, 'utf8'))).toMatchObject({
      tree: [{ title: 'Bookmarks bar' }],
    });
    expect((await stat(result.backupPath)).mode & 0o777).toBe(0o600);

    const failed = await runCli(
      ['browser', 'bookmarks.remove', '--payload', JSON.stringify({ id: '10' }), '--compact'],
      environment
    );
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('cannot remove bookmark');
    expect(failed.stderr).toContain('bookmark backup:');
    expect(commands).toEqual([
      'bookmarks.export',
      'bookmarks.export',
      'bookmarks.create',
      'bookmarks.export',
      'bookmarks.remove',
    ]);
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
    const discovery = parseJson(
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
    const discovery = parseJson(
      await readFile(path.join(runtimeDirectory, 'browser-control.json'), 'utf8')
    );
    expect(discovery).toMatchObject({ hostKind: 'standalone' });
    await runCli(['browser', 'host', 'stop'], { ...process.env, EV_HOME: evHome });
  }, 20_000);

  it('rejects arbitrary eval and direct user-tab actions before connecting to Desktop', async () => {
    const environment = {
      ...process.env,
      EV_BROWSER_CONTROL_FILE: path.join(os.tmpdir(), randomUUID()),
    };
    const arbitrary = await runCli(
      ['browser', 'page.eval', '--payload', '{"expression":"document.cookie"}'],
      environment
    );
    expect(arbitrary.exitCode).toBe(2);
    expect(arbitrary.stderr).toContain('unsupported browser action or invalid parameters');

    const direct = await runCli(['browser', 'page.snapshot'], environment);
    expect(direct.exitCode).toBe(2);
    expect(direct.stderr).toContain('workspace actions require session.command or oneShot');
  });
});
