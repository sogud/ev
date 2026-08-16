import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DSH_COLD_RESUME_UNSUPPORTED, DshRuntimeAdapter } from '../runtime/dsh-runtime-adapter';
import type { RuntimeSession } from '../runtime/runtime-adapter';

const directories: string[] = [];
const sessions: RuntimeSession[] = [];

function track(session: RuntimeSession): RuntimeSession {
  sessions.push(session);
  return session;
}

async function fixture(): Promise<{ directory: string; executable: string; configPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-dsh-discovery-'));
  directories.push(directory);
  const executable = path.join(directory, 'dsh-jsonrpc-agent');
  const configPath = path.join(directory, 'cordis.yml');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(configPath, '[]\n', { mode: 0o600 });
  return { directory, executable, configPath };
}

async function fakeRuntime(options: { beforeResponse?: boolean; delayMs?: number } = {}) {
  const result = await fixture();
  await writeFile(
    result.executable,
    `#!/usr/bin/env node
let input = '';
let serial = 0;
let seq = 0;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
const event = (sessionId, type, data, extra = {}) => send({ method: 'session.event', params: { sessionId, event: { type, seq: seq++, time: Date.now(), data, ...extra } } });
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  while (input.includes('\\n')) {
    const newline = input.indexOf('\\n');
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      send({ id: request.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } });
      continue;
    }
    if (request.method === 'session/prompt') {
      serial += 1;
      const run = serial;
      const sessionId = request.params.sessionId;
      const messageId = 'message-' + run;
      send({ method: 'session.status', params: { sessionId, status: 'running' } });
      const complete = () => {
        const prompt = request.params.contentBlocks[0].text;
        event(sessionId, 'agent/inbox/spliced', { inserted: [{ id: messageId }] });
        event(sessionId, 'user/message', { id: messageId, role: 'user', content: request.params.contentBlocks, source: { kind: 'user' } });
        if (prompt === 'structured') {
          event(sessionId, 'assistant/chunk', { turn: run, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } });
          event(sessionId, 'tool/call', { turn: run, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"README.md"}' });
          send({ method: 'subagent.started', params: { parentSessionId: sessionId, childSessionId: 'child-1' } });
          send({ method: 'subagent.finished', params: { provider: 'spawn', agentId: 'child-1', parentSessionId: sessionId, childSessionId: 'child-1', status: 'ok', stopReason: { kind: 'completed' } } });
          event(sessionId, 'tool/result', { turn: run, step: 1, message: { id: 'tool-result-1', role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }] }] } });
        }
        if (prompt === 'unknown-ignorable') {
          event(sessionId, 'future/info', { value: 1 }, { ignorable: true });
        }
        if (prompt === 'unknown-required') {
          event(sessionId, 'future/required', { value: 1 });
          return;
        }
        if (prompt === 'malformed-tool') {
          event(sessionId, 'tool/call', { turn: run, step: 1 });
          return;
        }
        if (prompt === 'fail') {
          event(sessionId, 'turn/end', { turn: run, reason: { kind: 'error', error: { code: 'MODEL_FAILED', message: 'model failed' } } });
          send({ method: 'session.status', params: { sessionId, status: 'idle' } });
          return;
        }
        const text = 'pid:' + process.pid + ' answer ' + run;
        const split = Math.floor(text.length / 2);
        event(sessionId, 'assistant/chunk', { turn: run, step: 1, chunk: { type: 'text-delta', index: 0, text: text.slice(0, split) } });
        event(sessionId, 'assistant/chunk', { turn: run, step: 1, chunk: { type: 'text-delta', index: 0, text: text.slice(split) } });
        event(sessionId, 'assistant/message', { turn: run, step: 1, message: { id: 'assistant-' + run, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } } });
        send({ method: 'session.status', params: { sessionId, status: 'idle' } });
      };
      const respond = () => send({ id: request.id, result: { messageId } });
      const delay = Number(process.env.DSH_FAKE_DELAY_MS || '0');
      if (process.env.DSH_FAKE_BEFORE_RESPONSE === '1') {
        setTimeout(() => { complete(); respond(); }, delay);
      } else {
        respond();
        setTimeout(complete, delay);
      }
      continue;
    }
    if (request.method === 'shutdown') {
      send({ id: request.id, result: {} });
      setTimeout(() => process.exit(0), 0);
    }
  }
});
`,
    { mode: 0o700 }
  );
  await chmod(result.executable, 0o700);
  return {
    ...result,
    environment: {
      HOME: result.directory,
      PATH: process.env.PATH,
      EV_HOME: path.join(result.directory, 'ev-home'),
      DSH_HOME: path.join(result.directory, 'dsh-home'),
      DSH_SESSION_ROOT: path.join(result.directory, 'dsh-home', 'sessions'),
      EV_DSH_RUNTIME: result.executable,
      EV_DSH_CONFIG: result.configPath,
      ...(options.beforeResponse ? { DSH_FAKE_BEFORE_RESPONSE: '1' } : {}),
      ...(options.delayMs ? { DSH_FAKE_DELAY_MS: String(options.delayMs) } : {}),
    },
  };
}

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(session => session.dispose()));
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

describe('DshRuntimeAdapter discovery', () => {
  it('describes an explicitly configured runtime without launching it', async () => {
    const { directory, executable, configPath } = await fixture();
    const adapter = new DshRuntimeAdapter({
      environment: {
        HOME: directory,
        PATH: '',
        EV_DSH_RUNTIME: executable,
        EV_DSH_CONFIG: configPath,
        DEEPSEEK_API_KEY: 'test-only-key',
      },
    });

    await expect(adapter.describe()).resolves.toMatchObject({
      id: 'dsh',
      name: 'DeepSeek Harness',
      glyph: 'DS',
      availability: 'available',
      auth: { status: 'logged_in' },
      capabilities: {
        models: false,
        thinkingLevels: false,
        tools: true,
        resumeSession: false,
        structuredEvents: true,
        permissionModes: false,
      },
    });
    await expect(adapter.listSessions()).resolves.toEqual([]);
  });

  it('reports a concrete setup message when its config is absent', async () => {
    const { directory, executable } = await fixture();
    const adapter = new DshRuntimeAdapter({
      environment: { HOME: directory, PATH: '', EV_DSH_RUNTIME: executable },
    });

    await expect(adapter.describe()).resolves.toMatchObject({
      id: 'dsh',
      availability: 'missing',
      message: 'Set EV_DSH_RUNTIME and EV_DSH_CONFIG to readable absolute paths',
      auth: { status: 'logged_out' },
    });
  });

  it('rejects a relative executable even when a task workspace contains that name', async () => {
    const { directory, configPath } = await fixture();
    const adapter = new DshRuntimeAdapter({
      environment: {
        HOME: directory,
        PATH: directory,
        EV_DSH_RUNTIME: './dsh-jsonrpc-agent',
        EV_DSH_CONFIG: configPath,
      },
    });

    await expect(adapter.describe()).resolves.toMatchObject({ availability: 'missing' });
    await expect(
      adapter.createSession({ cwd: directory, environment: process.env })
    ).rejects.toThrow('readable absolute paths');
  });

  it('streams one prompt through receipt-to-idle even when completion precedes the response', async () => {
    const runtime = await fakeRuntime({ beforeResponse: true });
    const adapter = new DshRuntimeAdapter({ environment: runtime.environment });
    const session = track(
      await adapter.createSession({
        cwd: runtime.directory,
        environment: runtime.environment,
      })
    );

    await session.promptAndWait('hello');

    expect(session.getEvents()).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'user', content: 'hello' })
    );
    const assistant = session
      .getEvents()
      .filter(event => event.type === 'message' && event.role === 'assistant')
      .at(-1);
    expect(assistant).toMatchObject({
      type: 'message',
      id: 'dsh:assistant:1:1',
      role: 'assistant',
    });
    expect(assistant?.type === 'message' ? assistant.content : '').toMatch(/^pid:\d+ answer 1$/);
    expect(session.getState()).toMatchObject({ status: 'idle' });
    await session.dispose();
  });

  it('isolates task processes and stopping one leaves the other usable', async () => {
    const runtime = await fakeRuntime();
    const adapter = new DshRuntimeAdapter({ environment: runtime.environment });
    const first = track(
      await adapter.createSession({
        cwd: runtime.directory,
        environment: runtime.environment,
      })
    );
    const second = track(
      await adapter.createSession({
        cwd: runtime.directory,
        environment: runtime.environment,
      })
    );

    await Promise.all([first.promptAndWait('first'), second.promptAndWait('second')]);
    const finalText = (session: typeof first) =>
      session
        .getEvents()
        .filter(event => event.type === 'message' && event.role === 'assistant')
        .at(-1);
    const firstText = finalText(first);
    const secondText = finalText(second);
    const firstPid =
      firstText?.type === 'message' ? firstText.content.match(/^pid:(\d+)/)?.[1] : '';
    const secondPid =
      secondText?.type === 'message' ? secondText.content.match(/^pid:(\d+)/)?.[1] : '';
    expect(firstPid).toBeTruthy();
    expect(secondPid).toBeTruthy();
    expect(firstPid).not.toBe(secondPid);

    await first.abort();
    await expect(first.promptAndWait('after stop')).rejects.toThrow(
      'DeepSeek Harness task was stopped'
    );
    await second.promptAndWait('still alive');
    expect(finalText(second)).toMatchObject({
      type: 'message',
      id: 'dsh:assistant:2:1',
    });
    await second.dispose();
  });

  it('rejects an active prompt when the task is stopped', async () => {
    const runtime = await fakeRuntime({ delayMs: 1_000 });
    const adapter = new DshRuntimeAdapter({ environment: runtime.environment });
    const session = track(
      await adapter.createSession({
        cwd: runtime.directory,
        environment: runtime.environment,
      })
    );
    let unsubscribe: () => void = () => undefined;
    const running = new Promise<void>(resolve => {
      unsubscribe = session.subscribe(event => {
        if (event.type === 'status' && event.status === 'running') resolve();
      });
    });
    const pending = session.promptAndWait('stop me');
    await running;
    unsubscribe();

    const rejected = expect(pending).rejects.toThrow('DeepSeek Harness task was stopped');
    const stopping = session.abort();
    expect(session.dispose()).toBe(stopping);
    await stopping;
    await rejected;
    expect(session.getState()).toMatchObject({
      status: 'error',
      error: 'DeepSeek Harness task was stopped',
    });
  });

  it('projects reasoning, tools, and subagents without mixing trace events into messages', async () => {
    const runtime = await fakeRuntime();
    const adapter = new DshRuntimeAdapter({ environment: runtime.environment });
    const session = track(
      await adapter.createSession({
        cwd: runtime.directory,
        environment: runtime.environment,
      })
    );

    await session.promptAndWait('structured');

    expect(session.getEvents()).toContainEqual(
      expect.objectContaining({
        type: 'message',
        id: 'dsh:thinking:1:1',
        role: 'thinking',
        content: 'thinking',
      })
    );
    expect(
      session
        .getEvents()
        .filter(event => event.type === 'message' && event.id === 'dsh:tool:call-1')
        .map(event => (event.type === 'message' ? event.toolStatus : undefined))
    ).toEqual(['running', 'done']);
    expect(
      session
        .getEvents()
        .filter(event => event.type === 'trace' && event.id === 'dsh:subagent:child-1')
        .map(event => (event.type === 'trace' ? event.status : undefined))
    ).toEqual(['running', 'done']);
    expect(
      session.getEvents().some(event => event.type === 'message' && event.id.includes('child-1'))
    ).toBe(false);
    await session.dispose();
  });

  it('returns pre-response turn errors and stops on unknown required or malformed consumed events', async () => {
    const runtime = await fakeRuntime({ beforeResponse: true });
    const adapter = new DshRuntimeAdapter({ environment: runtime.environment });
    const failed = track(
      await adapter.createSession({
        cwd: runtime.directory,
        environment: runtime.environment,
      })
    );
    await expect(failed.promptAndWait('fail')).rejects.toThrow('MODEL_FAILED: model failed');
    expect(failed.getState()).toMatchObject({
      status: 'error',
      error: 'MODEL_FAILED: model failed',
    });
    await failed.dispose();

    const future = track(
      await adapter.createSession({
        cwd: runtime.directory,
        environment: runtime.environment,
      })
    );
    await expect(future.promptAndWait('unknown-ignorable')).resolves.toBeUndefined();
    await expect(future.promptAndWait('unknown-required')).rejects.toThrow(
      'unknown required session event: future/required'
    );
    await future.dispose();

    const malformed = track(
      await adapter.createSession({
        cwd: runtime.directory,
        environment: runtime.environment,
      })
    );
    await expect(malformed.promptAndWait('malformed-tool')).rejects.toThrow(
      'invalid tool/call callId'
    );
    await malformed.dispose();
  });

  it('rejects cold resume without reading native DSH history', async () => {
    const adapter = new DshRuntimeAdapter();
    await expect(
      adapter.resumeSession({
        cwd: '/tmp',
        session: { runtimeId: 'dsh', nativeId: 'session-existing' },
      })
    ).rejects.toThrow(DSH_COLD_RESUME_UNSUPPORTED);
  });
});
