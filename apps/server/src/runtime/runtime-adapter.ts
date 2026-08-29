import type { RuntimeDescriptor, RuntimeEvent, RuntimeId, RuntimeSessionRef } from '@ev/contracts';
import type { ModelRef, PromptImage, ThinkingLevel } from '@ev/contracts/domain';
import type { CommandInfo } from '@ev/contracts/domain';

export class RuntimeSessionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeSessionUnavailableError';
  }
}

export interface RuntimeSessionRecord {
  ref: RuntimeSessionRef;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
}

export interface RuntimeSessionInput {
  cwd: string;
  name?: string;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  session?: RuntimeSessionRef;
  environment?: NodeJS.ProcessEnv;
  skillPaths?: string[];
  appendSystemPrompts?: string[];
}

export interface RuntimeSessionState {
  ref: RuntimeSessionRef;
  status: 'idle' | 'running' | 'error';
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  error?: string;
}

export interface RuntimeSession {
  readonly runtimeId: RuntimeId;
  getState(): RuntimeSessionState;
  getEvents(): RuntimeEvent[];
  prompt(text: string, images?: PromptImage[]): Promise<void>;
  promptAndWait(text: string, images?: PromptImage[]): Promise<void>;
  /** Queue a message into a running turn (Pi steer/follow_up); absent = runtime cannot queue. */
  queueMessage?(text: string, queue: 'steer' | 'followUp', images?: PromptImage[]): Promise<void>;
  /** Native slash commands / skills invocable via prompt; absent = none. */
  listCommands?(): Promise<CommandInfo[]>;
  abort(): Promise<void>;
  setModel?(provider: string, modelId: string): Promise<void>;
  setThinkingLevel?(level: ThinkingLevel): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface AgentRuntimeAdapter {
  readonly id: RuntimeId;
  describe(): Promise<RuntimeDescriptor>;
  listSessions(): Promise<RuntimeSessionRecord[]>;
  createSession(input: RuntimeSessionInput): Promise<RuntimeSession>;
  resumeSession(
    input: RuntimeSessionInput & { session: RuntimeSessionRef }
  ): Promise<RuntimeSession>;
  dispose?(): Promise<void>;
}
