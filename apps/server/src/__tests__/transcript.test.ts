import { describe, expect, it } from 'vitest';
import { normalizeMessage, normalizeToolEvent } from '../transcript';

describe('transcript normalization', () => {
  it('normalizes assistant text, thinking and tool calls', () => {
    const items = normalizeMessage({
      role: 'assistant',
      timestamp: 10,
      content: [
        { type: 'thinking', thinking: 'checking' },
        { type: 'text', text: 'done' },
        { type: 'toolCall', name: 'read', arguments: { path: '/tmp/a' } },
      ],
    });

    expect(items.map(item => item.kind)).toEqual(['thinking', 'assistant', 'tool']);
    expect(items[2]).toMatchObject({ toolName: 'read', toolStatus: 'running' });
  });

  it('normalizes a completed tool event', () => {
    expect(
      normalizeToolEvent({
        type: 'tool_execution_end',
        toolCallId: '1',
        toolName: 'bash',
        result: { output: 'ok' },
        isError: false,
      })
    ).toMatchObject({ id: 'tool-1', toolStatus: 'done', content: '{\n  "output": "ok"\n}' });
  });
});
