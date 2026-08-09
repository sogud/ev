import { describe, expect, it } from 'vitest';
import { runtimeAvailabilityTone, runtimeMonogram } from './runtimeMeta';

describe('runtimeMeta', () => {
  it('为四个 runtime 提供 monogram 兜底', () => {
    expect(runtimeMonogram('pi')).toBe('π');
    expect(runtimeMonogram('codex')).toBe('Cx');
    expect(runtimeMonogram('claude-code')).toBe('Cl');
    expect(runtimeMonogram('qoder')).toBe('Qd');
  });

  it('可用性映射到语义色档', () => {
    expect(runtimeAvailabilityTone('available')).toBe('ok');
    expect(runtimeAvailabilityTone('missing')).toBe('err');
    expect(runtimeAvailabilityTone('unsupported')).toBe('warn');
  });
});
