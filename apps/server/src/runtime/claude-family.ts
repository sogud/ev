import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
 * Claude Code 与 Qoder CLI 共享的 stream-json 子进程协议适配。
 * 两个 CLI 同源（-p --input-format stream-json --output-format stream-json，
 * ~/.<cli>/projects/<cwd-encoded>/*.jsonl 会话存储），因此映射与会话索引共用一份。
 */

export interface ClaudeFamilyFlavor {
  runtimeId: RuntimeId;
  executable: string;
  pathEnvVar: string;
  projectsDirName: string; // '.claude' | '.qoder'
  /** qodercli 不支持 --verbose（P0 回归根因）；claude-code 需要它开 stream-json 详细事件。 */
  supportsVerbose: boolean;
  /** 两家 permission-mode 词表不同：claude=acceptEdits，qoder=accept_edits。 */
  permissionModeValue: string;
  /** 思考强度 CLI flag：claude=--effort，qoder=--reasoning-effort。 */
  effortFlag: string;
  /** EV thinkingLevel → 各家 effort 词表映射（P2 定案）。 */
  effortValue(level: ThinkingLevel): string;
  /** 模型候选表：claude=官方别名；qoder=`--list-models` 快照（2026-08-08）。 */
  modelCatalog: Array<{ id: string; name: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 纯函数：一条 stream-json 记录 → 0..n 个 RuntimeEvent。单测直接喂记录。 */
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
      // 用户提问进 transcript：text 块合并为一条 user 消息（id 用 record.uuid 兜底）。
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
    // 恢复会话时先用 jsonl 历史填充 transcript，否则恢复的会话看起来是空的，
    // 且 setRuntime 的「已有消息即锁定」检查会误判为未开始。只留 message 事件。
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
  // claude 有效词表：low/medium/high/xhigh/max（--effort 实测，2026-08-08）。
  effortValue: level => (level === 'off' || level === 'minimal' ? 'low' : level),
  // 候选来源：claude --model 官方别名（亦接受完整模型名）。
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
  // qoder 词表收敛到 low/medium/high 三档（--reasoning-effort 实测不报错但档位有限）。
  effortValue: level =>
    level === 'off' || level === 'minimal' || level === 'low'
      ? 'low'
      : level === 'medium'
        ? 'medium'
        : 'high',
  // 候选来源：`qodercli --list-models` 快照（2026-08-08）。
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
    // macOS GUI 的 PATH 极简，子进程需要登录 shell PATH + 固定兜底列表。
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
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'subagents') continue; // 子代理侧链，不算主会话
      files.push(...collectJsonlFiles(full, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return files;
}

/** 读取单个 jsonl 文件的全部记录；文件缺失或行损坏时跳过，不阻断会话索引/恢复。 */
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
      // 跳过损坏行。
    }
  }
  return records;
}

/** 递归 ~/.<cli>/projects 下所有 .jsonl → 原生历史索引（cwd 取自记录自带字段）。 */
export function listClaudeFamilySessions(
  homeDir: string,
  flavor: ClaudeFamilyFlavor
): RuntimeSessionRecord[] {
  const root = path.join(homeDir, flavor.projectsDirName, 'projects');
  const records: RuntimeSessionRecord[] = [];
  for (const file of collectJsonlFiles(root, 0)) {
    try {
      const stat = statSync(file);
      let title = '新任务';
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
        if (title !== '新任务' || !isRecord(record.message)) continue;
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
      // 单个会话文件读取失败时跳过该文件。
    }
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}
