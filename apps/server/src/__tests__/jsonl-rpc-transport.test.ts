import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { JsonlRpcTransport, type RpcResponseMatch } from '../runtime/jsonl-rpc-transport';

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

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/** pi-style response matching: {type:'response', id, success, data/error}. */
function matchResponse(record: unknown): RpcResponseMatch | null {
  if (!isRecord(record) || record.type !== 'response' || typeof record.id !== 'string') return null;
  if (record.success === false) {
    return {
      id: record.id,
      ok: false,
      error: new Error(typeof record.error === 'string' ? record.error : 'request failed'),
    };
  }
  return { id: record.id, ok: true, value: record.data };
}

function makeTransport(child: ChildProcessWithoutNullStreams, timeoutMs?: number) {
  const transport = new JsonlRpcTransport({
    process: {
      executable: '/usr/local/bin/fake',
      args: [],
      cwd: '/tmp',
      launch: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    },
    matchResponse,
    timeoutMs,
    timeoutMessage: label => `fake ${label} timed out`,
  });
  return transport;
}

const writeLine = (child: ChildProcessWithoutNullStreams, record: unknown): void => {
  (child.stdout as PassThrough).write(`${JSON.stringify(record)}\n`);
};

describe('JsonlRpcTransport', () => {
  it('resolves id-correlated responses and passes other records through', async () => {
    const child = fakeProcess();
    const transport = makeTransport(child);
    await transport.start();

    const passthrough: unknown[] = [];
    transport.onRecord(record => passthrough.push(record));

    const pending = transport.request('req-1', { id: 'req-1', type: 'get_state' }, 'get_state');
    writeLine(child, { type: 'message', id: 'm1' }); // not a response -> passthrough
    writeLine(child, { type: 'response', id: 'req-1', success: true, data: { ok: 1 } });

    await expect(pending).resolves.toEqual({ ok: 1 });
    expect(passthrough).toEqual([{ type: 'message', id: 'm1' }]);
    await transport.stop();
  });

  it('rejects with the protocol error on success:false', async () => {
    const child = fakeProcess();
    const transport = makeTransport(child);
    await transport.start();
    const pending = transport.request('req-1', { id: 'req-1', type: 'boom' }, 'boom');
    writeLine(child, { type: 'response', id: 'req-1', success: false, error: 'nope' });
    await expect(pending).rejects.toThrow('nope');
    await transport.stop();
  });

  it('times out with the label message and cleans the pending table', async () => {
    const child = fakeProcess();
    const transport = makeTransport(child, 50);
    await transport.start();
    await expect(transport.request('req-1', { id: 'req-1', type: 'slow' }, 'slow')).rejects.toThrow(
      'fake slow timed out'
    );
    // a late response for the timed-out id is dropped, not resurrected.
    writeLine(child, { type: 'response', id: 'req-1', success: true, data: 1 });
    await transport.stop();
  });

  it('exit rejects every in-flight request with the process error', async () => {
    const child = fakeProcess();
    const transport = makeTransport(child);
    await transport.start();
    const pending = transport.request('req-1', { id: 'req-1', type: 'x' }, 'x');
    (child.stderr as PassThrough).write('boom stderr');
    child.emit('exit', 1, null);
    await expect(pending).rejects.toThrow('boom stderr');
  });

  it('stop rejects pending requests', async () => {
    const child = fakeProcess();
    const transport = makeTransport(child);
    await transport.start();
    const pending = transport.request('req-1', { id: 'req-1', type: 'x' }, 'x');
    await transport.stop('stopped by test');
    await expect(pending).rejects.toThrow('stopped by test');
  });
});
