import { describe, expect, it } from 'vitest';
import type { TraceEvent } from './shared/types';
import {
  buildTrajectory,
  formatDuration,
  formatTokens,
  formatTimestamp,
  tokensLabel,
} from './trajectory-view-model';

function event(partial: Partial<TraceEvent> & Pick<TraceEvent, 'id' | 'type'>): TraceEvent {
  return { title: partial.type, status: 'done', timestamp: 1000, ...partial };
}

describe('buildTrajectory', () => {
  it('groups rows into turns delimited by model events', () => {
    const view = buildTrajectory([
      event({ id: 'run-1', type: 'model', title: 'pi run', status: 'done', tokensIn: 200 }),
      event({ id: 'tool-1', type: 'tool', title: 'edit' }),
      event({ id: 'tool-2', type: 'tool', title: 'bash' }),
      event({ id: 'run-2', type: 'model', title: 'pi run' }),
      event({ id: 'tool-3', type: 'tool', title: 'read' }),
    ]);

    expect(view.turns).toHaveLength(2);
    expect(view.turns[0]).toMatchObject({ index: 1, kind: 'turn' });
    expect(view.turns[0].rows.map(row => row.event.id)).toEqual(['run-1', 'tool-1', 'tool-2']);
    expect(view.turns[1]).toMatchObject({ index: 2, kind: 'turn' });
    expect(view.turns[1].rows.map(row => row.event.id)).toEqual(['run-2', 'tool-3']);
  });

  it('puts events before the first model event into a setup bucket', () => {
    const view = buildTrajectory([
      event({ id: 'sys-1', type: 'system', title: 'session created' }),
      event({ id: 'run-1', type: 'model', title: 'pi run' }),
    ]);

    expect(view.turns).toHaveLength(2);
    expect(view.turns[0]).toMatchObject({ index: 0, kind: 'setup' });
    expect(view.turns[0].rows.map(row => row.event.id)).toEqual(['sys-1']);
    expect(view.turns[1]).toMatchObject({ index: 1, kind: 'turn' });
  });

  it('numbers rows globally and sequentially', () => {
    const view = buildTrajectory([
      event({ id: 'sys-1', type: 'system' }),
      event({ id: 'run-1', type: 'model' }),
      event({ id: 'tool-1', type: 'tool' }),
    ]);
    const indexes = view.turns.flatMap(turn => turn.rows.map(row => row.index));
    expect(indexes).toEqual([1, 2, 3]);
  });

  it('keeps running rows intact without inventing duration or tokens', () => {
    const view = buildTrajectory([
      event({ id: 'run-1', type: 'model', status: 'running' }),
      event({ id: 'tool-1', type: 'tool', status: 'running' }),
    ]);
    const rows = view.turns[0].rows;
    expect(rows[0].event.durationMs).toBeUndefined();
    expect(rows[0].event.tokensIn).toBeUndefined();
    expect(tokensLabel(rows[0].event)).toBeNull();
    expect(tokensLabel(rows[1].event)).toBeNull();
  });

  it('returns no turns for an empty trace', () => {
    expect(buildTrajectory([])).toEqual({ turns: [] });
  });
});

describe('trajectory formatters', () => {
  it('formats token counts with k/m suffixes', () => {
    expect(formatTokens(undefined)).toBeNull();
    expect(formatTokens(340)).toBe('340');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(2000)).toBe('2k');
    expect(formatTokens(1_500_000)).toBe('1.5m');
  });

  it('formats durations without fabricating for undefined', () => {
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(4200)).toBe('4.2s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('formats timestamps through the locale time string', () => {
    expect(formatTimestamp(1000)).toBe(new Date(1000).toLocaleTimeString());
  });

  it('builds a token label only when at least one side is known', () => {
    expect(tokensLabel(event({ id: 'a', type: 'model' }))).toBeNull();
    expect(tokensLabel(event({ id: 'b', type: 'model', tokensIn: 1200, tokensOut: 40 }))).toBe(
      '1.2k → 40'
    );
    expect(tokensLabel(event({ id: 'c', type: 'model', tokensOut: 40 }))).toBe('? → 40');
  });
});
