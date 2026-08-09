import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  RuntimeDescriptorSchema,
  type RuntimeDescriptor,
  type RuntimeEvent,
  type RuntimeId,
  type RuntimeSessionRef,
} from '@ev/contracts';
import { JsonlProcess } from './jsonl-process';
import { launchEnvironment, resolveExecutable } from './executable';
import { probeClaude, probeQoder } from '../auth-probe';
import type { ThinkingLevel } from '@ev/contracts/domain';
import type {
  AgentRuntimeAdapter,
  RuntimeSession,
  RuntimeSessionInput,
  RuntimeSessionRecord,
  RuntimeSessionState,
} from './runtime-adapter';

const execFileAsync = promisify(execFile);

/**
 * Shared stream-json subprocess protocol adapter for Claude Code and Qoder CLI.
 * Both CLIs speak the same protocol (-p --input-format stream-json
 * --output-format stream-json, session storage under
 * ~/.<cli>/projects/<cwd-encoded>/*.jsonl), so one mapping and one session index
 * serve both.
 */

export interface ClaudeFamilyFlavor {
  runtimeId: RuntimeId;
  executable: string;
  pathEnvVar: string;
  projectsDirName: string; // '.claude' | '.qoder'
  /** qodercli does not support --verbose (P0 regression root cause); claude-code needs it for detailed stream-json events. */
  supportsVerbose: boolean;
  /** The permission-mode vocabularies differ: claude=acceptEdits, qoder=accept_edits. */
  permissionModeValue: string;
  /** Thinking-effort CLI flag: claude=--effort, qoder=--reasoning-effort. */
  effortFlag: string;
  /** EV thinkingLevel -> per-CLI effort vocabulary mapping (settled in P2). */
  effortValue(level: ThinkingLevel): string;
  /** Model candidate table: claude=official aliases; qoder=`--list-models` snapshot (2026-08-08). */
  modelCatalog: Array<{ id: string; name: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Pure function: one stream-json record -> 0..n RuntimeEvents. Unit tests feed records directly. */
export function mapClaudeFamilyRecord(record: unknown): RuntimeEvent[] {
  if (!isRecord(record)) return [];
  const type = asString(record.type);
  const events: RuntimeEvent[] = [];
  const id = asString(record.uuid) ?? asString(record.session_id) ?? `rec-${events.length}`;

  if (type === 'assistant' && isRecord(record.message)) {
    const content = (record.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const [index, block] of content.entries()) {
        if (!isRecord(block)) continue;
        const blockType = asString(block.type);
        const blockId = asString(block.id) ?? `${id}-${index}`;
        if (blockType === 'text') {
          const text = asString(block.text);
          if (text)
            events.push({
              type: 'message',
              id: blockId,
              role: 'assistant',
              content: text,
              timestamp: Date.now(),
            });
        } else if (blockType === 'thinking') {
          const thinking = asString(block.thinking) ?? asString(block.text);
          if (thinking)
            events.push({
              type: 'message',
              id: blockId,
              role: 'thinking',
              content: thinking,
              timestamp: Date.now(),
            });
        } else if (blockType === 'tool_use') {
          events.push({
            type: 'message',
            id: blockId,
            role: 'tool',
            toolName: asString(block.name) ?? 'tool',
            toolStatus: 'running',
            content: JSON.stringify(block.input ?? {}),
            timestamp: Date.now(),
          });
        }
      }
    }
  } else if (type === 'user' && isRecord(record.message)) {
    const content = (record.message as Record<string, unknown>).content;
    if (typeof content === 'string') {
      if (content)
        events.push({
          type: 'message',
          id,
          role: 'user',
          content,
          timestamp: Date.now(),
        });
    } else if (Array.isArray(content)) {
      // user prompts enter the transcript: text blocks merge into a single user message (id falls back to record.uuid).
      const texts = content
        .filter(
          (block): block is Record<string, unknown> => isRecord(block) && block.type === 'text'
        )
        .map(block => asString(block.text) ?? '')
        .filter(Boolean);
      if (texts.length > 0)
        events.push({
          type: 'message',
          id,
          role: 'user',
          content: texts.join('\n'),
          timestamp: Date.now(),
        });
      for (const [index, block] of content.entries()) {
        if (!isRecord(block) || block.type !== 'tool_result') continue;
        const raw = block.content;
        const text =
          typeof raw === 'string'
            ? raw
            : Array.isArray(raw)
              ? raw
                  .filter(isRecord)
                  .map(part => asString(part.text) ?? '')
                  .join('\n')
              : '';
        events.push({
          type: 'message',
          id: asString(block.tool_use_id) ?? `${id}-${index}`,
          role: 'tool',
          toolName: 'tool_result',
          toolStatus: block.is_error === true ? 'error' : 'done',
          content: text,
          timestamp: Date.now(),
        });
      }
    }
  } else if (type === 'result') {
    if (record.is_error === true) {
      events.push({
        type: 'message',
        id,
        role: 'error',
        content: asString(record.result) ?? 'runtime result error',
        timestamp: Date.now(),
      });
    }
    events.push({ type: 'status', status: record.is_error === true ? 'error' : 'idle' });
  }
  return events;
}

export class ClaudeFamilySession implements RuntimeSession {
  readonly runtimeId: RuntimeId;
  private readonly process: JsonlProcess;
  private state: RuntimeSessionState;
  private readonly events: RuntimeEvent[] = [];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(
    flavor: ClaudeFamilyFlavor,
    input: RuntimeSessionInput,
    resumeRef: RuntimeSessionRef | null,
    executablePath: string,
    history: readonly unknown[] = []
  ) {
    this.runtimeId = flavor.runtimeId;
    const sessionId = resumeRef?.nativeId ?? randomUUID();
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      ...(flavor.supportsVerbose ? ['--verbose'] : []),
      '--permission-mode',
      flavor.permissionModeValue,
      ...(input.model ? ['--model', input.model.id] : []),
      ...(input.thinkingLevel && input.thinkingLevel !== 'off'
        ? [flavor.effortFlag, flavor.effortValue(input.thinkingLevel)]
        : []),
      resumeRef ? '--resume' : '--session-id',
      sessionId,
    ];
    this.process = new JsonlProcess({
      executable: executablePath,
      args,
      cwd: input.cwd,
      env: input.environment,
    });
    this.state = {
      ref: {
        runtimeId: flavor.runtimeId,
        nativeId: sessionId,
      },
      status: 'idle',
      model: input.model,
      thinkingLevel: input.thinkingLevel,
    };
    // On resume, seed the transcript from the jsonl history first; otherwise a
    // resumed session looks empty and setRuntime's "messages mean locked" check
    // misreads it as never started. Keep only message events.
    for (const record of history) {
      for (const event of mapClaudeFamilyRecord(record)) {
        if (event.type === 'message') this.events.push(event);
      }
    }
    this.process.onRecord(record => {
      if (isRecord(record)) {
        const sessionIdFromInit = asString(record.session_id);
        if (sessionIdFromInit && record.type === 'system') {
          this.state = { ...this.state, ref: { ...this.state.ref, nativeId: sessionIdFromInit } };
        }
      }
      for (const event of mapClaudeFamilyRecord(record)) this.emit(event);
    });
    this.process.onExit(error => {
      if (error) this.emit({ type: 'status', status: 'error', error: error.message });
    });
  }

  getState(): RuntimeSessionState {
    return this.state;
  }

  getEvents(): RuntimeEvent[] {
    return [...this.events];
  }

  async prompt(text: string): Promise<void> {
    this.emit({ type: 'status', status: 'running' });
    await this.process.start();
    this.process.send({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  }

  async promptAndWait(text: string): Promise<void> {
    await this.prompt(text);
  }

  async abort(): Promise<void> {
    await this.process.stop();
    this.emit({ type: 'status', status: 'idle' });
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    await this.process.stop();
  }

  private emit(event: RuntimeEvent): void {
    if (event.type === 'status') {
      this.state = {
        ...this.state,
        status: event.status,
        error: event.status === 'error' ? (event.error ?? this.state.error) : undefined,
      };
    }
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }
}

export const CLAUDE_CODE_FLAVOR: ClaudeFamilyFlavor = {
  runtimeId: 'claude-code',
  executable: 'claude',
  pathEnvVar: 'EV_CLAUDE_CODE_PATH',
  projectsDirName: '.claude',
  supportsVerbose: true,
  permissionModeValue: 'acceptEdits',
  effortFlag: '--effort',
  // claude effective vocabulary: low/medium/high/xhigh/max (--effort, verified 2026-08-08).
  effortValue: level => (level === 'off' || level === 'minimal' ? 'low' : level),
  // candidates: claude --model official aliases (full model names also accepted).
  modelCatalog: [
    { id: 'sonnet', name: 'Claude Sonnet' },
    { id: 'opus', name: 'Claude Opus' },
    { id: 'haiku', name: 'Claude Haiku' },
  ],
};

export const QODER_FLAVOR: ClaudeFamilyFlavor = {
  runtimeId: 'qoder',
  executable: 'qodercli',
  pathEnvVar: 'EV_QODER_PATH',
  projectsDirName: '.qoder',
  supportsVerbose: false,
  permissionModeValue: 'accept_edits',
  effortFlag: '--reasoning-effort',
  // qoder vocabulary narrows to low/medium/high (--reasoning-effort accepts more without error but the effective tiers are limited).
  effortValue: level =>
    level === 'off' || level === 'minimal' || level === 'low'
      ? 'low'
      : level === 'medium'
        ? 'medium'
        : 'high',
  // candidates: `qodercli --list-models` snapshot (2026-08-08).
  modelCatalog: [
    { id: 'Auto', name: 'Auto' },
    { id: 'Ultimate', name: 'Ultimate' },
    { id: 'Performance', name: 'Performance' },
    { id: 'Efficient', name: 'Efficient' },
    { id: 'Qwen3.8-Max', name: 'Qwen3.8-Max' },
    { id: 'Kimi-K3', name: 'Kimi-K3' },
    { id: 'GLM-5.2', name: 'GLM-5.2' },
    { id: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro' },
  ],
};

export class ClaudeFamilyAdapter implements AgentRuntimeAdapter {
  readonly id: RuntimeId;

  constructor(
    private readonly flavor: ClaudeFamilyFlavor,
    private readonly options: { environment?: NodeJS.ProcessEnv } = {}
  ) {
    this.id = flavor.runtimeId;
  }

  private executable(): Promise<string | null> {
    return resolveExecutable(
      this.flavor.executable,
      this.flavor.pathEnvVar,
      this.options.environment
    );
  }

  async describe(): Promise<RuntimeDescriptor> {
    const executable = await this.executable();
    let version: string | undefined;
    if (executable) {
      try {
        version = (await execFileAsync(executable, ['--version'], { timeout: 5_000 })).stdout
          .trim()
          .split(' ')[0];
      } catch {
        version = undefined;
      }
    }
    return RuntimeDescriptorSchema.parse({
      id: this.flavor.runtimeId,
      name: this.flavor.runtimeId === 'qoder' ? 'Qoder' : 'Claude Code',
      glyph: this.flavor.runtimeId === 'qoder' ? 'Qd' : 'Cl',
      availability: executable ? 'available' : 'missing',
      ...(version ? { version } : {}),
      ...(executable ? {} : { message: 'CLI not detected on PATH' }),
      modelCatalog: this.flavor.modelCatalog,
      auth: this.flavor.runtimeId === 'qoder' ? probeQoder() : await probeClaude(),
      capabilities: {
        models: true,
        thinkingLevels: true,
        tools: true,
        resumeSession: true,
        structuredEvents: true,
        permissionModes: true,
      },
    });
  }

  async listSessions(): Promise<RuntimeSessionRecord[]> {
    return listClaudeFamilySessions(os.homedir(), this.flavor);
  }

  async createSession(input: RuntimeSessionInput): Promise<RuntimeSession> {
    const executable = await this.executable();
    if (!executable) throw new Error(`${this.flavor.executable} CLI not found`);
    // macOS GUI PATH is minimal; children need the login-shell PATH plus a fixed fallback list.
    const environment = await launchEnvironment(input.environment);
    return new ClaudeFamilySession(this.flavor, { ...input, environment }, null, executable);
  }

  async resumeSession(
    input: RuntimeSessionInput & { session: RuntimeSessionRef }
  ): Promise<RuntimeSession> {
    const executable = await this.executable();
    if (!executable) throw new Error(`${this.flavor.executable} CLI not found`);
    const environment = await launchEnvironment(input.environment);
    const history = input.session.sessionFile ? readJsonlRecords(input.session.sessionFile) : [];
    return new ClaudeFamilySession(
      this.flavor,
      { ...input, environment },
      input.session,
      executable,
      history
    );
  }
}

function collectJsonlFiles(dir: string, depth: number): string[] {
  if (depth > 3) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'subagents') continue; // subagent side chains are not main sessions
      files.push(...collectJsonlFiles(full, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return files;
}

/** Read every record of one jsonl file; missing files and corrupt lines are skipped without breaking the session index/resume. */
function readJsonlRecords(file: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const records: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip corrupt lines.
    }
  }
  return records;
}

/** Recurse ~/.<cli>/projects for all .jsonl -> native history index (cwd taken from each record's own field). */
export function listClaudeFamilySessions(
  homeDir: string,
  flavor: ClaudeFamilyFlavor
): RuntimeSessionRecord[] {
  const root = path.join(homeDir, flavor.projectsDirName, 'projects');
  const records: RuntimeSessionRecord[] = [];
  for (const file of collectJsonlFiles(root, 0)) {
    try {
      const stat = statSync(file);
      let title = 'New task';
      let sessionId = path.basename(file, '.jsonl');
      let cwd: string | undefined;
      let messageCount = 0;
      for (const record of readJsonlRecords(file)) {
        if (!isRecord(record)) continue;
        cwd = cwd ?? asString(record.cwd);
        const sid = asString(record.sessionId) ?? asString(record.session_id);
        if (sid) sessionId = sid;
        if (record.type !== 'user') continue;
        messageCount += 1;
        if (title !== 'New task' || !isRecord(record.message)) continue;
        const content = (record.message as Record<string, unknown>).content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? asString(
                  content.find(
                    (block): block is Record<string, unknown> =>
                      isRecord(block) && block.type === 'text'
                  )?.text
                )
              : undefined;
        if (text) title = text.slice(0, 80);
      }
      if (!cwd) continue;
      records.push({
        ref: { runtimeId: flavor.runtimeId, nativeId: sessionId, sessionFile: file },
        title,
        cwd,
        createdAt: stat.birthtimeMs,
        updatedAt: stat.mtimeMs,
        messageCount,
      });
    } catch {
      // skip a session file that fails to read.
    }
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}
