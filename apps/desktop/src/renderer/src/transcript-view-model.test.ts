import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../shared/types';
import { buildTranscriptView, extractChangedPaths } from './transcript-view-model';

function item(
  partial: Partial<TranscriptItem> & Pick<TranscriptItem, 'id' | 'kind'>
): TranscriptItem {
  return { content: '', timestamp: 1000, ...partial };
}

describe('extractChangedPaths', () => {
  it('parses Pi edit/write args', () => {
    expect(extractChangedPaths('edit', JSON.stringify({ path: 'src/a.ts', oldText: 'x' }))).toEqual(
      ['src/a.ts']
    );
    expect(extractChangedPaths('write', JSON.stringify({ file_path: 'src/b.ts' }))).toEqual([
      'src/b.ts',
    ]);
  });

  it('parses Codex fileChange changes array', () => {
    const content = JSON.stringify({
      type: 'fileChange',
      changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { kind: 'add' }],
    });
    expect(extractChangedPaths('fileChange', content)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns nothing for non-mutating tools or bad json', () => {
    expect(extractChangedPaths('read', JSON.stringify({ path: 'src/a.ts' }))).toEqual([]);
    expect(extractChangedPaths('bash', 'not json')).toEqual([]);
    expect(extractChangedPaths('edit', 'not json')).toEqual([]);
  });
});

describe('buildTranscriptView', () => {
  it('groups by user messages and keeps results in doc', () => {
    const view = buildTranscriptView(
      [
        item({ id: 'u1', kind: 'user', content: '修一下按钮', timestamp: 1000 }),
        item({ id: 't1', kind: 'thinking', content: '先看 CSS', timestamp: 1001 }),
        item({
          id: 'tool1',
          kind: 'tool',
          toolName: 'bash',
          toolStatus: 'done',
          content: '$ tsc',
          timestamp: 1002,
        }),
        item({
          id: 'tool2',
          kind: 'tool',
          toolName: 'edit',
          toolStatus: 'done',
          content: JSON.stringify({ path: 'src/styles.css' }),
          timestamp: 1003,
        }),
        item({ id: 'a1', kind: 'assistant', content: '已修复。', timestamp: 1004 }),
        item({ id: 'u2', kind: 'user', content: '再改一处', timestamp: 2000 }),
        item({ id: 'a2', kind: 'assistant', content: '完成。', timestamp: 2001 }),
      ],
      false
    );

    expect(view.turns).toHaveLength(2);
    const [first, second] = view.turns;
    expect(first.userText).toBe('修一下按钮');
    expect(first.doc.map(block => block.text)).toEqual(['已修复。']);
    expect(first.changedFiles).toEqual([{ path: 'src/styles.css', tool: 'edit' }]);
    expect(first.startedAt).toBe(1000);
    expect(first.endedAt).toBe(1004);
    expect(first.running).toBe(false);
    expect(second.userText).toBe('再改一处');
  });

  it('dedupes changed files within a turn and ignores read tools', () => {
    const view = buildTranscriptView(
      [
        item({ id: 'u1', kind: 'user', timestamp: 1 }),
        item({
          id: 'r1',
          kind: 'tool',
          toolName: 'read',
          content: JSON.stringify({ path: 'x.ts' }),
          timestamp: 2,
        }),
        item({
          id: 'e1',
          kind: 'tool',
          toolName: 'edit',
          content: JSON.stringify({ path: 'x.ts' }),
          timestamp: 3,
        }),
        item({
          id: 'e2',
          kind: 'tool',
          toolName: 'write',
          content: JSON.stringify({ path: 'x.ts' }),
          timestamp: 4,
        }),
      ],
      false
    );
    expect(view.turns[0].changedFiles).toEqual([{ path: 'x.ts', tool: 'edit' }]);
  });

  it('marks only the last turn running and supports leading assistant items', () => {
    const view = buildTranscriptView(
      [
        item({ id: 'a0', kind: 'assistant', content: '恢复的历史', timestamp: 10 }),
        item({ id: 'u1', kind: 'user', content: '新问题', timestamp: 20 }),
      ],
      true
    );
    expect(view.turns).toHaveLength(2);
    expect(view.turns[0].userText).toBeNull();
    expect(view.turns[0].running).toBe(false);
    expect(view.turns[1].running).toBe(true);
  });

  it('routes error items into doc with error tone, system as normal', () => {
    const view = buildTranscriptView(
      [
        item({ id: 'u1', kind: 'user', timestamp: 1 }),
        item({ id: 'e1', kind: 'error', content: 'boom', timestamp: 2 }),
        item({ id: 's1', kind: 'system', content: 'note', timestamp: 3 }),
      ],
      false
    );
    expect(view.turns[0].doc).toEqual([
      { id: 'e1', text: 'boom', tone: 'error' },
      { id: 's1', text: 'note', tone: 'normal' },
    ]);
  });
});
