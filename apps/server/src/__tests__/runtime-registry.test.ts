import { describe, expect, it, vi } from 'vitest';
import type { RuntimeId } from '@ev/contracts';
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

describe('RuntimeRegistry', () => {
  it('requires Pi and exposes real Pi and Codex adapters', async () => {
    const pi = adapter('pi');
    const codex = adapter('codex');
    const registry = new RuntimeRegistry([pi, codex]);

    expect(registry.require('pi')).toBe(pi);
    expect(registry.require('codex')).toBe(codex);
    expect((await registry.describeAll()).map(item => item.id)).toEqual(['pi', 'codex']);
  });

  it('rejects duplicate or missing Pi adapters', () => {
    expect(() => new RuntimeRegistry([adapter('pi'), adapter('pi')])).toThrow('Duplicate');
    expect(() => new RuntimeRegistry([adapter('codex')])).toThrow('Pi runtime adapter is required');
  });
});
