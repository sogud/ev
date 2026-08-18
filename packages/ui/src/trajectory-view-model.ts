import type { TraceEvent } from './shared/types';

/**
 * Expression-layer view-model for the trajectory table (DSH-trajectory P1).
 * Pure function: TraceEvent[] -> turn-grouped rows. A model event opens a new
 * turn (task-session emits exactly one merged model row per agent run); events
 * before the first model event land in a leading "setup" bucket.
 */

export interface TrajectoryRowView {
  event: TraceEvent;
  /** 1-based global sequence number across the whole trace. */
  index: number;
}

export interface TrajectoryTurnView {
  id: string;
  /** 1-based turn number; the setup bucket is 0. */
  index: number;
  kind: 'setup' | 'turn';
  rows: TrajectoryRowView[];
}

export interface TrajectoryView {
  turns: TrajectoryTurnView[];
}

export function buildTrajectory(trace: readonly TraceEvent[]): TrajectoryView {
  const turns: TrajectoryTurnView[] = [];
  let current: TrajectoryTurnView | null = null;
  let turnCount = 0;
  let seq = 0;

  const openTurn = (kind: TrajectoryTurnView['kind']): TrajectoryTurnView => {
    const turn: TrajectoryTurnView = {
      id: `trajectory-${turns.length}`,
      index: kind === 'setup' ? 0 : ++turnCount,
      kind,
      rows: [],
    };
    turns.push(turn);
    return turn;
  };

  for (const event of trace) {
    if (event.type === 'model') current = openTurn('turn');
    else if (!current) current = openTurn('setup');
    current.rows.push({ event, index: ++seq });
  }
  return { turns };
}

/** 1234 -> "1.2k"; undefined stays undefined so the UI never invents data. */
export function formatTokens(count: number | undefined): string | null {
  if (count === undefined) return null;
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${trimZero((count / 1000).toFixed(1))}k`;
  return `${trimZero((count / 1_000_000).toFixed(2))}m`;
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

/** "1.2k → 340"; null when neither side is known (e.g. running rows). */
export function tokensLabel(event: TraceEvent): string | null {
  const input = formatTokens(event.tokensIn);
  const output = formatTokens(event.tokensOut);
  if (input === null && output === null) return null;
  return `${input ?? '?'} → ${output ?? '?'}`;
}

function trimZero(text: string): string {
  return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
