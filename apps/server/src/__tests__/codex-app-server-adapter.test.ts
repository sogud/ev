import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from '../runtime/codex-app-server-adapter';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })));
});

async function fakeCodex(completionBeforeResponse = false): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-fake-codex-'));
  directories.push(directory);
  const executable = path.join(directory, 'codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
let buffer = '';
process.stdin.setEncoding('utf8');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const thread = {id:'codex-thread-1',sessionId:'codex-session-1',preview:'History',name:null,cwd:'/tmp',path:'/tmp/codex.jsonl',createdAt:10,updatedAt:20,turns:[]};
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n'); const line = buffer.slice(0,index); buffer = buffer.slice(index+1);
    if (!line) continue;
    const request = JSON.parse(line); if (!request.id) continue;
    if (request.method === 'initialize') send({id:request.id,result:{userAgent:'fake'}});
    else if (request.method === 'thread/list') send({id:request.id,result:{data:[thread],nextCursor:null}});
    else if (request.method === 'thread/start' || request.method === 'thread/resume') send({id:request.id,result:{thread,model:'gpt-test',modelProvider:'openai'}});
    else if (request.method === 'turn/start') {
      const turn = {id:'turn-1',status:'inProgress',items:[]};
      const complete = () => {
        send({method:'turn/started',params:{threadId:thread.id,turn}});
        send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,completedAtMs:30,item:{type:'agentMessage',id:'answer-1',text:'answer'}}});
        send({method:'turn/completed',params:{threadId:thread.id,turn:{...turn,status:'completed'}}});
      };
      if (${completionBeforeResponse}) complete();
      send({id:request.id,result:{turn}});
      if (!${completionBeforeResponse}) complete();
    }
  }
});
`,
    { mode: 0o700 }
  );
  await chmod(executable, 0o700);
  return executable;
}

describe('CodexAppServerAdapter', () => {
  it('lists, creates, and streams native Codex threads over app-server JSONL', async () => {
    const adapter = new CodexAppServerAdapter({
      environment: { ...process.env, EV_CODEX_CLI: await fakeCodex() },
      cwd: '/tmp',
    });

    expect(await adapter.describe()).toMatchObject({
      id: 'codex',
      availability: 'available',
      version: 'codex-cli 1.0.0',
    });
    expect(await adapter.listSessions()).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ runtimeId: 'codex', nativeId: 'codex-thread-1' }),
        title: 'History',
        cwd: '/tmp',
      }),
    ]);

    const session = await adapter.createSession({ cwd: '/tmp' });
    await session.promptAndWait('hello');
    expect(session.getEvents()).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'assistant', content: 'answer' })
    );
    expect(session.getState()).toMatchObject({ status: 'idle' });
    await session.dispose();
    await adapter.dispose();
  });

  it('handles turn completion arriving before the turn/start response', async () => {
    const adapter = new CodexAppServerAdapter({
      environment: { ...process.env, EV_CODEX_CLI: await fakeCodex(true) },
      cwd: '/tmp',
    });
    const session = await adapter.createSession({ cwd: '/tmp' });
    await session.promptAndWait('fast');
    expect(session.getState()).toMatchObject({ status: 'idle' });
    await session.abort();
    await session.dispose();
    await adapter.dispose();
  });
});
