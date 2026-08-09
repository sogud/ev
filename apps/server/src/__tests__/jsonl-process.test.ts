import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { JsonlProcess } from '../runtime/jsonl-process';

function fakeProcess(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  child.kill = vi.fn(() => {
    Object.defineProperty(child, 'exitCode', { value: 0, writable: true });
    queueMicrotask(() => child.emit('exit', 0, null));
    return true;
  });
  return child;
}

describe('JsonlProcess', () => {
  it('uses strict LF framing and preserves Unicode line separators across chunks', async () => {
    const child = fakeProcess();
    const host = new JsonlProcess({
      executable: '/usr/local/bin/pi',
      args: ['--mode', 'rpc'],
      cwd: '/tmp',
      launch: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    });
    const records: unknown[] = [];
    host.onRecord(record => records.push(record));

    await host.start();
    const payload = `${JSON.stringify({ type: 'message', text: 'a\u2028b' })}\n`;
    const bytes = Buffer.from(payload);
    (child.stdout as PassThrough).write(bytes.subarray(0, 7));
    (child.stdout as PassThrough).write(bytes.subarray(7));
    await vi.waitFor(() => expect(records).toEqual([{ type: 'message', text: 'a\u2028b' }]));

    host.send({ id: 'request-1', type: 'get_state' });
    const input = await new Promise<string>(resolve => {
      (child.stdin as PassThrough).setEncoding('utf8');
      child.stdin.once('data', chunk => resolve(String(chunk)));
    });
    expect(input).toBe('{"id":"request-1","type":"get_state"}\n');
    await host.stop();
  });
});
