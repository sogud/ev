import type { TranscriptItem } from '@ev/contracts/domain';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function messageTimestamp(message: UnknownRecord): number {
  return typeof message.timestamp === 'number' ? message.timestamp : Date.now();
}

export function normalizeMessage(message: unknown): TranscriptItem[] {
  if (!isRecord(message)) return [];

  const role = typeof message.role === 'string' ? message.role : 'system';
  const timestamp = messageTimestamp(message);
  const baseId = `${role}-${timestamp}`;
  const content = message.content;

  const toolResultItem = (text: string): TranscriptItem => ({
    id: baseId,
    kind: 'tool',
    toolName: typeof message.toolName === 'string' ? message.toolName : 'tool',
    toolStatus: message.isError === true ? 'error' : 'done',
    content: text,
    timestamp,
  });

  if (typeof content === 'string') {
    if (role === 'toolResult') return [toolResultItem(content)];
    return [{ id: baseId, kind: role === 'user' ? 'user' : 'system', content, timestamp }];
  }

  if (role === 'toolResult') {
    const text = Array.isArray(content)
      ? content
          .map(block => (isRecord(block) && block.type === 'text' ? asText(block.text) : ''))
          .filter(Boolean)
          .join('\n')
      : asText(content);
    return [toolResultItem(text)];
  }

  if (!Array.isArray(content)) return [];

  return content.flatMap((block, index): TranscriptItem[] => {
    if (!isRecord(block) || typeof block.type !== 'string') return [];
    const id = `${baseId}-${index}`;

    if (block.type === 'text') {
      const kind = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system';
      return [{ id, kind, content: asText(block.text), timestamp }];
    }

    if (block.type === 'thinking') {
      return [{ id, kind: 'thinking', content: asText(block.thinking), timestamp }];
    }

    if (block.type === 'toolCall') {
      return [
        {
          id,
          kind: 'tool',
          toolName: typeof block.name === 'string' ? block.name : 'tool',
          toolStatus: 'running',
          content: asText(block.arguments),
          timestamp,
        },
      ];
    }

    return [{ id, kind: 'system', content: asText(block), timestamp }];
  });
}

export function normalizeMessages(messages: readonly unknown[]): TranscriptItem[] {
  return messages.flatMap(normalizeMessage);
}

export function normalizeToolEvent(event: UnknownRecord): TranscriptItem | undefined {
  if (typeof event.toolCallId !== 'string') return undefined;
  const type = typeof event.type === 'string' ? event.type : '';
  const isError = event.isError === true;
  const status = type === 'tool_execution_end' ? (isError ? 'error' : 'done') : 'running';
  const value =
    type === 'tool_execution_start' ? event.args : (event.result ?? event.partialResult);

  return {
    id: `tool-${event.toolCallId}`,
    kind: 'tool',
    toolName: typeof event.toolName === 'string' ? event.toolName : 'tool',
    toolStatus: status,
    content: value === undefined ? '' : asText(value),
    timestamp: Date.now(),
  };
}
