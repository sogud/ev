import type { RuntimeId } from '@ev/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEvKernel, type EvKernel } from '../kernel/ev-kernel';

const kernels: EvKernel[] = [];

afterEach(async () => {
  await Promise.allSettled(kernels.splice(0).map(kernel => kernel.dispose()));
});

describe('EV Kernel', () => {
  it('mounts every built-in Runtime as a static Cordis plugin', async () => {
    const kernel = await createEvKernel();
    kernels.push(kernel);
    const ids: RuntimeId[] = ['pi', 'codex', 'claude-code', 'qoder', 'dsh'];

    for (const id of ids) expect(kernel.runtimes.require(id).id).toBe(id);
    kernel.runtimes.assertRequired('pi');
  });

  it('disposes the root Context idempotently', async () => {
    const kernel = await createEvKernel();
    kernels.push(kernel);

    const first = kernel.dispose();
    expect(kernel.dispose()).toBe(first);
    await first;
    await expect(kernel.dispose()).resolves.toBeUndefined();
  });

  it('attempts every Runtime cleanup when root disposal fails', async () => {
    const kernel = await createEvKernel();
    kernels.push(kernel);
    const pi = kernel.runtimes.require('pi');
    const codex = kernel.runtimes.require('codex');
    const piFailure = new Error('pi cleanup failed');
    const codexFailure = new Error('codex cleanup failed');
    pi.dispose = vi.fn(async () => {
      throw piFailure;
    });
    codex.dispose = vi.fn(async () => {
      throw codexFailure;
    });

    const disposal = kernel.dispose();

    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    expect(pi.dispose).toHaveBeenCalledOnce();
    expect(codex.dispose).toHaveBeenCalledOnce();
  });
});
