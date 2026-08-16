import type { RuntimeId } from '@ev/contracts';
import { Context, type Plugin } from 'cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeAdapter } from '../runtime/runtime-adapter';
import { RuntimeRegistry } from '../runtime/runtime-registry';

function adapter(id: RuntimeId): AgentRuntimeAdapter {
  return {
    id,
    describe: vi.fn(async () => ({
      id,
      name: id === 'pi' ? 'Pi' : 'Codex CLI',
      availability: 'available' as const,
      capabilities: {
        models: true,
        thinkingLevels: true,
        tools: true,
        resumeSession: true,
        structuredEvents: true,
        permissionModes: id === 'codex',
      },
    })),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(),
    resumeSession: vi.fn(),
  };
}

const contexts: Context[] = [];

function registry(...adapters: AgentRuntimeAdapter[]): RuntimeRegistry {
  const context = new Context();
  contexts.push(context);
  const runtimes = new RuntimeRegistry(context);
  for (const runtime of adapters) runtimes.register(runtime);
  return runtimes;
}

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()));
});

describe('RuntimeRegistry', () => {
  it('requires Pi and exposes adapters in registration order', async () => {
    const pi = adapter('pi');
    const codex = adapter('codex');
    const runtimes = registry(codex, pi);
    runtimes.assertRequired('pi');

    expect(runtimes.require('pi')).toBe(pi);
    expect(runtimes.require('codex')).toBe(codex);
    expect((await runtimes.describeAll()).map(item => item.id)).toEqual(['pi', 'codex']);
  });

  it('rejects duplicate registrations and reports a missing required Runtime', () => {
    const pi = adapter('pi');
    const runtimes = registry(pi);

    expect(() => runtimes.register(adapter('pi'))).toThrow('Duplicate');
    expect(() => runtimes.assertRequired('codex')).toThrow('codex runtime adapter is required');
    expect(runtimes.require('pi')).toBe(pi);
  });

  it('unloads one plugin registration without affecting sibling Runtimes', async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(RuntimeRegistry);
    const pi = adapter('pi');
    const codex = adapter('codex');
    pi.dispose = vi.fn(async () => undefined);
    codex.dispose = vi.fn(async () => undefined);
    const runtimePlugin = (name: string, runtime: AgentRuntimeAdapter): Plugin.Object<void> => ({
      name,
      inject: ['runtimes'],
      apply(ctx) {
        ctx.runtimes.register(runtime);
      },
    });
    const piFiber = await context.plugin(runtimePlugin('test-runtime-pi', pi));
    await context.plugin(runtimePlugin('test-runtime-codex', codex));

    await piFiber.dispose();

    expect(() => context.runtimes.require('pi')).toThrow('Runtime is not registered');
    expect(context.runtimes.require('codex')).toBe(codex);
    expect(pi.dispose).toHaveBeenCalledOnce();
    expect(codex.dispose).not.toHaveBeenCalled();
    await context.fiber.dispose();
    expect(pi.dispose).toHaveBeenCalledOnce();
    expect(codex.dispose).toHaveBeenCalledOnce();
  });

  it('attempts every adapter dispose and reports all failures', async () => {
    const pi = adapter('pi');
    const codex = adapter('codex');
    const failure = new Error('pi dispose failed');
    pi.dispose = vi.fn(async () => {
      throw failure;
    });
    codex.dispose = vi.fn(async () => undefined);
    const runtimes = registry(pi, codex);

    const disposing = runtimes.dispose();

    await expect(disposing).rejects.toBeInstanceOf(AggregateError);
    await expect(disposing).rejects.toMatchObject({ errors: [failure] });
    expect(pi.dispose).toHaveBeenCalledOnce();
    expect(codex.dispose).toHaveBeenCalledOnce();
  });
});
