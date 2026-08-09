import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listClaudeFamilySessions, mapClaudeFamilyRecord, QODER_FLAVOR } from './claude-family';

describe('mapClaudeFamilyRecord', () => {
  it('maps assistant text and tool_use blocks', () => {
    const events = mapClaudeFamilyRecord({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'done', id: 't1' },
          { type: 'tool_use', id: 'tool1', name: 'edit', input: { path: 'a.ts' } },
        ],
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ role: 'assistant', content: 'done' });
    expect(events[1]).toMatchObject({ role: 'tool', toolName: 'edit', toolStatus: 'running' });
  });

  it('maps tool_result with error flag', () => {
    const events = mapClaudeFamilyRecord({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'boom', is_error: true }],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ role: 'tool', toolStatus: 'error', content: 'boom' });
  });

  it('maps result records to status and error', () => {
    expect(mapClaudeFamilyRecord({ type: 'result', is_error: false })).toEqual([
      { type: 'status', status: 'idle' },
    ]);
    const failed = mapClaudeFamilyRecord({ type: 'result', is_error: true, result: 'bad' });
    expect(failed[0]).toMatchObject({ role: 'error', content: 'bad' });
    expect(failed[1]).toEqual({ type: 'status', status: 'error' });
  });

  it('ignores unknown records', () => {
    expect(mapClaudeFamilyRecord({ type: 'progress' })).toEqual([]);
    expect(mapClaudeFamilyRecord('nope')).toEqual([]);
  });
});

describe('listClaudeFamilySessions', () => {
  it('indexes transcripts, skips subagents, reads cwd from records', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'ev-claude-family-'));
    const encoded = '-Users-me-proj';
    const dir = path.join(home, '.qoder', 'projects', encoded, 'transcript');
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(home, '.qoder', 'projects', encoded, 'subagents'), { recursive: true });
    writeFileSync(
      path.join(dir, 's1.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', sessionId: 's1', cwd: '/Users/me/proj' }),
        JSON.stringify({ type: 'user', message: { content: 'hello there' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      ].join('\n')
    );
    writeFileSync(
      path.join(home, '.qoder', 'projects', encoded, 'subagents', 'side.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'sidechain' } })
    );

    const records = listClaudeFamilySessions(home, QODER_FLAVOR);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cwd: '/Users/me/proj',
      title: 'hello there',
      messageCount: 1,
    });
    expect(records[0].ref.nativeId).toBe('s1');
  });
});
