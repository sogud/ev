import type { TranscriptItem } from '../../shared/types';

/**
 * Transcript 表达层 view-model mapper（spec: desktop-interaction-expression-layer-v1）。
 * 纯函数：runtime 中立的 TranscriptItem[] → 表达结构。
 * 主流程 = 结果（doc 块 + Changed Files 卡片 + turn 脚注）；过程信息 v1 不展示，留给检查器。
 */

export interface ChangedFileView {
  path: string;
  tool: string;
}

export interface DocBlock {
  id: string;
  text: string;
  tone: 'normal' | 'error';
}

export interface TurnView {
  id: string;
  userText: string | null;
  doc: DocBlock[];
  changedFiles: ChangedFileView[];
  startedAt: number;
  endedAt: number;
  running: boolean;
}

export interface TranscriptView {
  turns: TurnView[];
}

// 全部小写；匹配时先 toLowerCase，兼容 Claude 报的 Edit/Write/MultiEdit 首字母大写。
const MUTATING_TOOLS = new Set([
  'edit',
  'write',
  'apply_patch',
  'patch',
  'multiedit',
  'filechange',
]);

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 从工具调用的 content（args 或 item JSON）里提取被修改的文件路径。 */
export function extractChangedPaths(toolName: string, content: string): string[] {
  if (!MUTATING_TOOLS.has(toolName.toLowerCase()) || !content) return [];
  const parsed = parseJson(content);
  if (!isRecord(parsed)) return [];

  // Codex fileChange item: { changes: [{ path, ... }] }
  if (Array.isArray(parsed.changes)) {
    return parsed.changes
      .filter(isRecord)
      .map(change => change.path)
      .filter((path): path is string => typeof path === 'string' && path.length > 0);
  }

  // Pi edit/write args: { path | file_path }
  for (const key of ['path', 'file_path', 'filePath']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.length > 0) return [value];
  }
  return [];
}

export function buildTranscriptView(
  items: readonly TranscriptItem[],
  running: boolean
): TranscriptView {
  const turns: TurnView[] = [];
  let current: TurnView | null = null;

  const newTurn = (userText: string | null, timestamp: number): TurnView => {
    const turn: TurnView = {
      id: `turn-${turns.length}`,
      userText,
      doc: [],
      changedFiles: [],
      startedAt: timestamp,
      endedAt: timestamp,
      running: false,
    };
    turns.push(turn);
    return turn;
  };

  for (const item of items) {
    if (item.kind === 'user') {
      current = newTurn(item.content, item.timestamp);
      continue;
    }
    if (!current) current = newTurn(null, item.timestamp);
    current.endedAt = Math.max(current.endedAt, item.timestamp);

    if (item.kind === 'assistant' || item.kind === 'system') {
      current.doc.push({ id: item.id, text: item.content, tone: 'normal' });
    } else if (item.kind === 'error') {
      current.doc.push({ id: item.id, text: item.content, tone: 'error' });
    } else if (item.kind === 'tool') {
      const toolName = item.toolName ?? 'tool';
      for (const path of extractChangedPaths(toolName, item.content)) {
        if (!current.changedFiles.some(file => file.path === path)) {
          current.changedFiles.push({ path, tool: toolName });
        }
      }
    }
  }

  if (turns.length > 0) turns[turns.length - 1].running = running;
  return { turns };
}
