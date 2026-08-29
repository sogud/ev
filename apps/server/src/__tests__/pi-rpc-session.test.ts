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
    else if (request.type === 'get_commands') send({id:request.id,type:'response',command:'get_commands',success:true,data:{commands:[{name:'skill:ev-browser',description:'Browser ops',source:'skill'}]}});
    else if (request.type === 'steer' || request.type === 'follow_up') {
      send({id:request.id,type:'response',command:request.type,success:true});
      send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'cmd:'+request.type}],timestamp:Date.now()}});
      send({type:'agent_settled'});
    }
    else if (request.type === 'prompt') {
      send({id:request.id,type:'response',command:'prompt',success:true});
      send({type:'agent_start'});
      send({type:'message_start',message:{role:'assistant',content:[],timestamp:2}});
      send({type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:0}});
      send({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'ans'}});
      send({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'wer'}});
      send({type:'tool_execution_start',toolCallId:'tc1',toolName:'bash',args:{command:'ls'}});
      send({type:'tool_execution_end',toolCallId:'tc1',toolName:'bash',result:'file.txt'});
      const answer = request.images?.[0]?.mimeType ?? 'answer';
      send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:answer}],provider:'test',model:'test-model',timestamp:2,usage:{input:120,output:30}}});
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

    const seen: RuntimeEvent[] = [];
    session.subscribe(event => seen.push(event));
    await session.promptAndWait('hello');
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'assistant', content: 'ans' })
    );
    expect(session.getEvents()).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'assistant', content: 'answer' })
    );
    expect(session.getState().status).toBe('idle');
    await session.dispose();
  });

  it('passes image attachments through the Pi RPC prompt', async () => {
    const session = await PiRpcSession.create(await fakePi(), { cwd: '/tmp' });
    await session.promptAndWait('inspect', [
      { type: 'image', data: 'cG5n', mimeType: 'image/png', fileName: 'shot.png' },
    ]);
    expect(session.getEvents()).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'assistant', content: 'image/png' })
    );
    await session.dispose();
  });

  it('lists native slash commands and maps queue modes to Pi wire names', async () => {
    const session = await PiRpcSession.create(await fakePi(), { cwd: '/tmp' });

    expect(await session.listCommands()).toEqual([
      { name: 'skill:ev-browser', description: 'Browser ops', source: 'skill' },
    ]);

    await session.queueMessage('insert', 'steer');
    await session.queueMessage('tail', 'followUp');
    const contents = session
      .getEvents()
      .flatMap(event =>
        event.type === 'message' && event.role === 'assistant' ? [event.content] : []
      );
    expect(contents).toContain('cmd:steer');
    expect(contents).toContain('cmd:follow_up');
    await session.dispose();
  });

  it('ignores impossible streamed content indexes', async () => {
    const session = await PiRpcSession.create(await fakePi(), { cwd: '/tmp' });
    const handleRecord = (
      session as unknown as { handleRecord(value: unknown): void }
    ).handleRecord.bind(session);

    handleRecord({
      type: 'message_start',
      message: { role: 'assistant', content: [], timestamp: 99 },
    });
    expect(() =>
      handleRecord({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: Number.MAX_SAFE_INTEGER,
          delta: 'ignored',
        },
      })
    ).not.toThrow();
    expect(session.getEvents()).not.toContainEqual(
      expect.objectContaining({ type: 'message', content: 'ignored' })
    );
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
