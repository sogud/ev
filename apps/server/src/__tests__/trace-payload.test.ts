import { describe, expect, it } from 'vitest';
import { tokenCounts, traceText } from '../runtime/trace-payload';

describe('tokenCounts', () => {
  it('reads the pi usage shape', () => {
    expect(tokenCounts({ input: 100, output: 40, cacheRead: 5 })).toEqual({
      tokensIn: 100,
      tokensOut: 40,
    });
  });

  it('reads the Anthropic usage shape', () => {
    expect(tokenCounts({ input_tokens: 100, output_tokens: 40 })).toEqual({
      tokensIn: 100,
      tokensOut: 40,
    });
  });

  it('reads the OpenAI-style usage shape', () => {
    expect(tokenCounts({ prompt_tokens: 100, completion_tokens: 40 })).toEqual({
      tokensIn: 100,
      tokensOut: 40,
    });
  });

  it('drops invalid or missing counts instead of inventing them', () => {
    expect(tokenCounts({ input: -5, output: 'many' })).toEqual({});
    expect(tokenCounts(undefined)).toEqual({});
    expect(tokenCounts({})).toEqual({});
    expect(tokenCounts({ input: 12.9 })).toEqual({ tokensIn: 12 });
  });
});

describe('traceText', () => {
  it('stringifies objects and caps oversized payloads', () => {
    expect(traceText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(traceText('x'.repeat(2 * 1024 * 1024))).toHaveLength(1024 * 1024);
  });
});
