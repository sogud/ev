import type { RuntimeEvent } from '@ev/contracts';
import { RuntimeEventSchema } from '@ev/contracts';
import type { ThinkingLevel } from '@ev/contracts/domain';

const MAX_CONTENT_CHARS = 1024 * 1024;
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function joinText(value: unknown): string {
  return Array.isArray(value)
    ? value
        .filter(isRecord)
        .map(entry => entry.text)
        .filter((entry): entry is string => typeof entry === 'string')
        .join('\n')
    : '';
}

function joinLines(value: unknown): string {
  return Array.isArray(value) ? value.join('\n') : '';
}

/** Cap + stringify so a hostile/huge item can never blow up the transcript. */
export function boundedText(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2);
          } catch {
            return String(value);
          }
        })();
  return text.slice(0, MAX_CONTENT_CHARS);
}

export function codexMessage(
  id: string,
  role: Extract<RuntimeEvent, { type: 'message' }>['role'],
  content: string,
  timestamp: number,
  extra: { toolName?: string; toolStatus?: 'running' | 'done' | 'error' } = {}
): RuntimeEvent {
  return RuntimeEventSchema.parse({ type: 'message', id, role, content, timestamp, ...extra });
}

type ItemMapper = (
  item: UnknownRecord,
  id: string,
  timestamp: number,
  completed: boolean
) => RuntimeEvent[];

const toolStatusOf = (item: UnknownRecord, completed: boolean): 'running' | 'done' | 'error' =>
  completed ? (item.status === 'failed' ? 'error' : 'done') : 'running';

/** Same-id tool trace row; task-session merges start (input) and completion (output). */
function codexToolTrace(
  id: string,
  title: string,
  timestamp: number,
  status: 'running' | 'done' | 'error',
  fields: { input?: string; output?: string } = {}
): RuntimeEvent {
  return RuntimeEventSchema.parse({
    type: 'trace',
    id,
    traceType: 'tool',
    title,
    status,
    timestamp,
    ...(fields.input !== undefined ? { input: fields.input } : {}),
    ...(fields.output !== undefined ? { output: fields.output } : {}),
  });
}

function optionalOutput(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : boundedText(value);
}

/**
 * Codex item.type -> RuntimeEvent[] mappers (same pure-seam pattern as
 * claude-family's mapClaudeFamilyRecord). Table-driven so each protocol kind
 * is unit-testable without a session; unknown kinds map to nothing.
 */
const ITEM_MAPPERS: Record<string, ItemMapper> = {
  userMessage: (item, id, timestamp) => [
    codexMessage(id, 'user', joinText(item.content), timestamp),
  ],
  agentMessage: (item, id, timestamp) => [
    codexMessage(id, 'assistant', boundedText(item.text), timestamp),
  ],
  reasoning: (item, id, timestamp) => [
    codexMessage(id, 'thinking', joinLines(item.summary) || joinLines(item.content), timestamp),
  ],
  commandExecution: (item, id, timestamp, completed) => [
    codexMessage(id, 'tool', boundedText(item.aggregatedOutput ?? item.command), timestamp, {
      toolName: 'command',
      toolStatus: toolStatusOf(item, completed),
    }),
    codexToolTrace(id, 'command', timestamp, toolStatusOf(item, completed), {
      ...(item.command !== undefined ? { input: boundedText(item.command) } : {}),
      output: optionalOutput(item.aggregatedOutput),
    }),
  ],
  fileChange: (item, id, timestamp, completed) => [
    codexMessage(id, 'tool', boundedText(item), timestamp, {
      toolName: 'fileChange',
      toolStatus: completed ? 'done' : 'running',
    }),
    codexToolTrace(id, 'fileChange', timestamp, completed ? 'done' : 'running', {
      input: boundedText(item.changes ?? item),
    }),
  ],
  mcpToolCall: (item, id, timestamp, completed) => [
    codexMessage(id, 'tool', boundedText(item), timestamp, {
      toolName: 'mcpToolCall',
      toolStatus: completed ? 'done' : 'running',
    }),
    codexToolTrace(
      id,
      typeof item.name === 'string' ? item.name : 'mcpToolCall',
      timestamp,
      completed ? (item.status === 'failed' ? 'error' : 'done') : 'running',
      {
        ...(item.arguments !== undefined ? { input: boundedText(item.arguments) } : {}),
        output: optionalOutput(item.result ?? item.output),
      }
    ),
  ],
  dynamicToolCall: (item, id, timestamp, completed) => [
    codexMessage(id, 'tool', boundedText(item), timestamp, {
      toolName: 'dynamicToolCall',
      toolStatus: completed ? 'done' : 'running',
    }),
    codexToolTrace(
      id,
      typeof item.name === 'string' ? item.name : 'dynamicToolCall',
      timestamp,
      completed ? (item.status === 'failed' ? 'error' : 'done') : 'running',
      {
        ...(item.arguments !== undefined ? { input: boundedText(item.arguments) } : {}),
        output: optionalOutput(item.result ?? item.output),
      }
    ),
  ],
};

/**
 * Pure protocol mapping: Codex item -> internal events. The turn state machine
 * (waiters / out-of-order completion) stays in CodexAppServerSession; this seam
 * only translates wire shapes.
 */
export function mapCodexItem(
  item: UnknownRecord,
  timestamp: number,
  completed: boolean
): RuntimeEvent[] {
  const id = typeof item.id === 'string' ? item.id : `codex-${timestamp}`;
  const mapper = typeof item.type === 'string' ? ITEM_MAPPERS[item.type] : undefined;
  return mapper ? mapper(item, id, timestamp, completed) : [];
}

/**
 * EV thinkingLevel -> Codex effort (settled in P2):
 * off/minimal→minimal，low/medium/high/xhigh 同名，max→ultra。
 */
const CODEX_EFFORT: Record<ThinkingLevel, string> = {
  off: 'minimal',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'ultra',
};

export function codexEffort(level: ThinkingLevel): string {
  return CODEX_EFFORT[level];
}
