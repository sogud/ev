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
  ],
  fileChange: (item, id, timestamp, completed) => [
    codexMessage(id, 'tool', boundedText(item), timestamp, {
      toolName: 'fileChange',
      toolStatus: completed ? 'done' : 'running',
    }),
  ],
  mcpToolCall: (item, id, timestamp, completed) => [
    codexMessage(id, 'tool', boundedText(item), timestamp, {
      toolName: 'mcpToolCall',
      toolStatus: completed ? 'done' : 'running',
    }),
  ],
  dynamicToolCall: (item, id, timestamp, completed) => [
    codexMessage(id, 'tool', boundedText(item), timestamp, {
      toolName: 'dynamicToolCall',
      toolStatus: completed ? 'done' : 'running',
    }),
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
