import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeEvent } from '@ev/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { PiRpcSession } from '../runtime/pi-rpc-session';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })));
});

async function fakePi(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ev-fake-pi-'));
  directories.push(directory);
  const executable = path.join(directory, 'pi');
  await writeFile(
    executable,
    `#!/usr/bin/env node
let buffer = '';
process.stdin.setEncoding('utf8');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n');
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.type === 'get_state') send({id:request.id,type:'response',command:'get_state',success:true,data:{sessionId:'pi-session-1',sessionFile:'/tmp/pi-session-1.jsonl',thinkingLevel:'medium',messageCount:1}});
    else if (request.type === 'get_messages') send({id:request.id,type:'response',command:'get_messages',success:true,data:{messages:[{role:'user',content:'history',timestamp:1}]}});
    else if (request.type === 'prompt') {
      send({id:request.id,type:'response',command:'prompt',success:true});
      send({type:'agent_start'});
      send({type:'message_update',message:{role:'assistant',content:[],timestamp:2}});
      send({type:'tool_execution_start',toolCallId:'tc1',toolName:'bash',args:{command:'ls'}});
      send({type:'tool_execution_end',toolCallId:'tc1',toolName:'bash',result:'file.txt'});
      send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'answer'}],provider:'test',model:'test-model',timestamp:2,usage:{input:120,output:30}}});
      send({type:'agent_settled'});
    } else send({id:request.id,type:'response',command:request.type,success:true});
  }
});
`,
    { mode: 0o700 }
  );
  await chmod(executable, 0o700);
  return executable;
}

describe('PiRpcSession', () => {
  it('loads native history and streams prompts through pi --mode rpc', async () => {
    const session = await PiRpcSession.create(await fakePi(), { cwd: '/tmp' });

    expect(session.getState()).toMatchObject({
      ref: {
        runtimeId: 'pi',
        nativeId: 'pi-session-1',
        sessionFile: '/tmp/pi-session-1.jsonl',
      },
      status: 'idle',
      thinkingLevel: 'medium',
    });
    expect(session.getEvents()).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'user', content: 'history' })
    );

    await session.promptAndWait('hello');
    expect(session.getEvents()).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'assistant', content: 'answer' })
    );
    expect(session.getState().status).toBe('idle');
    await session.dispose();
  });

  it('emits trace events with tool input/output, model usage and ttft', async () => {
    const session = await PiRpcSession.create(await fakePi(), { cwd: '/tmp' });
    const seen: RuntimeEvent[] = [];
    session.subscribe(event => seen.push(event));

    await session.promptAndWait('hello');

    const traces = seen.filter(
      (event): event is Extract<RuntimeEvent, { type: 'trace' }> => event.type === 'trace'
    );
    expect(traces).toContainEqual(
      expect.objectContaining({
        traceType: 'tool',
        id: 'tool-tc1',
        status: 'running',
        input: JSON.stringify({ command: 'ls' }, null, 2),
      })
    );
    expect(traces).toContainEqual(
      expect.objectContaining({
        traceType: 'tool',
        id: 'tool-tc1',
        status: 'done',
        output: 'file.txt',
      })
    );
    expect(traces).toContainEqual(
      expect.objectContaining({ traceType: 'model', tokensIn: 120, tokensOut: 30 })
    );
    expect(traces.some(event => typeof event.ttftMs === 'number')).toBe(true);
    await session.dispose();
  });
});
