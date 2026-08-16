import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeEvent } from '@ev/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { DshRuntimeAdapter } from '../runtime/dsh-runtime-adapter';
import type { RuntimeSession } from '../runtime/runtime-adapter';

const sourceRoot = process.env.EV_DSH_SOURCE_ROOT?.trim();
const directories: string[] = [];

afterEach(async () => {
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

describe.skipIf(!sourceRoot)('official DeepSeek Harness runtime smoke', () => {
  it('runs isolated EV sessions through the official source runtime and local model server', async () => {
    if (!sourceRoot) throw new Error('EV_DSH_SOURCE_ROOT is required');
    const root = await mkdtemp(path.join(os.tmpdir(), 'ev-dsh-official-smoke-'));
    directories.push(root);
    const workspace = path.join(root, 'workspace');
    const wrapper = path.join(root, 'dsh-jsonrpc-agent');
    const pidWitness = path.join(root, 'pids.txt');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      wrapper,
      `#!/bin/sh
printf '%s\\n' "$$" >> "$DSH_PID_WITNESS"
cd ${shellQuote(sourceRoot)}
exec ${shellQuote(process.execPath)} --import tsx packages/examples/jsonrpc-demo/src/bin.ts "$1"
`,
      { mode: 0o700 }
    );
    await chmod(wrapper, 0o700);

    const modelServer = await startModelServer();
    const address = modelServer.address();
    if (!address || typeof address === 'string') throw new Error('model server did not bind');
    const environment = {
      ...process.env,
      HOME: path.join(root, 'home'),
      EV_HOME: path.join(root, 'ev-home'),
      DSH_HOME: path.join(root, 'dsh-home'),
      DSH_SESSION_ROOT: path.join(root, 'dsh-home', 'sessions'),
      DSH_PID_WITNESS: pidWitness,
      EV_DSH_RUNTIME: wrapper,
      EV_DSH_CONFIG: path.join(sourceRoot, 'examples/jsonrpc-agent/cordis.yml'),
      DEEPSEEK_API_KEY: 'keyless-local-model-only',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
    };
    const adapter = new DshRuntimeAdapter({ environment });
    let first: RuntimeSession | undefined;
    let second: RuntimeSession | undefined;

    try {
      first = await adapter.createSession({ cwd: workspace, environment });
      second = await adapter.createSession({ cwd: workspace, environment });
      await Promise.all([
        first.promptAndWait('answer from the local model'),
        second.promptAndWait('answer from the local model'),
      ]);
      expect(lastAssistant(first.getEvents())).toMatch(/^local-done-\d+$/);
      expect(lastAssistant(second.getEvents())).toMatch(/^local-done-\d+$/);

      await first.abort();
      await second.promptAndWait('continue after the other task stopped');
      expect(lastAssistant(second.getEvents())).toMatch(/^local-done-\d+$/);

      const pids = (await readFile(pidWitness, 'utf8')).trim().split('\n');
      expect(new Set(pids).size).toBe(2);
      const sessionFiles = await readdir(environment.DSH_SESSION_ROOT, { recursive: true });
      expect(sessionFiles.some(file => file.endsWith('.jsonl.zstd'))).toBe(true);
    } finally {
      await Promise.allSettled([first?.dispose(), second?.dispose()]);
      await closeServer(modelServer);
    }
  }, 60_000);
});

async function startModelServer(): Promise<Server> {
  let serial = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      serial += 1;
      const text = `local-done-${serial}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n');
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      response.write(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n'
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function lastAssistant(events: RuntimeEvent[]): string {
  const event = events
    .filter(candidate => candidate.type === 'message' && candidate.role === 'assistant')
    .at(-1);
  return event?.type === 'message' ? event.content : '';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
