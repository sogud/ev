/**
 * Single home for EV domain types (shared by server / desktop / CLI / web).
 * Caveat: TaskSummary etc. in the root index.ts are browser-extension protocol types with a different shape; do not mix them.
 */
import type { RuntimeId, RuntimeSessionRef } from './runtime';

export type TaskStatus = 'idle' | 'running' | 'error';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface ModelRef {
  provider: string;
  id: string;
  name: string;
}

export interface PromptImage {
  type: 'image';
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  fileName?: string;
}

/** A slash command / skill invocable via prompt ("/name"); from the runtime's native command list. */
export interface CommandInfo {
  name: string;
  description?: string;
  source?: 'extension' | 'prompt' | 'skill';
}

export interface TaskSummary {
  id: string;
  title: string;
  cwd: string;
  sessionFile?: string;
  runtime?: RuntimeSessionRef;
  /** Lazy session-creation switch target: shown immediately, survives restarts, consumed on first ensure. */
  pendingRuntimeId?: RuntimeId;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  model?: ModelRef;
  thinkingLevel: ThinkingLevel;
  error?: string;
}

export interface TranscriptItem {
  id: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'error' | 'system';
  content: string;
  timestamp: number;
  toolName?: string;
  toolStatus?: 'running' | 'done' | 'error';
}

export interface TaskDetail extends TaskSummary {
  messages: TranscriptItem[];
  trace: TraceEvent[];
}

export type TraceEventType = 'model' | 'tool' | 'system' | 'retry' | 'compaction' | 'error';

export interface TraceEvent {
  id: string;
  type: TraceEventType;
  title: string;
  detail?: string;
  status: 'running' | 'done' | 'error';
  timestamp: number;
  durationMs?: number;
  /** Token usage reported by the runtime; absent when the runtime cannot provide it. */
  tokensIn?: number;
  tokensOut?: number;
  /** Tool input / model request payload; producers truncate oversized text. */
  input?: string;
  /** Tool output / model response payload; producers truncate oversized text. */
  output?: string;
  /** Time to first token (ms) for model events; absent when unknown. */
  ttftMs?: number;
}

export interface WorkspaceChanges {
  isGitRepository: boolean;
  files: Array<{ path: string; status: string }>;
  diff: string;
  error?: string;
}

export interface TaskInspection {
  trace: TraceEvent[];
  changes: WorkspaceChanges;
}

export interface ProviderSummary {
  id: string;
  name: string;
  baseUrl?: string;
  authStatus: 'configured' | 'missing' | 'expired' | 'unknown';
  supportsApiKey: boolean;
  supportsOAuth: boolean;
  custom: boolean;
  models: ModelSummary[];
}

export interface ModelSummary {
  id: string;
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
  contextWindow: number;
  available: boolean;
}

export interface ResourceItem {
  name: string;
  description?: string;
  path: string;
  source?: string;
}

export interface ResourceSnapshot {
  skills: ResourceItem[];
  extensions: ResourceItem[];
  packages: string[];
  skillPaths: string[];
  extensionPaths: string[];
  diagnostics: string[];
}

export interface AppSettings {
  defaultWorkspace: string | null;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel: ThinkingLevel;
  defaultRuntime: RuntimeId;
  theme: ThemePreference;
  /** UI language preference; null/undefined = follow system locale. */
  language?: 'en' | 'zh' | null;
}

export interface ResourceSettingsInput {
  packages: string[];
  skillPaths: string[];
  extensionPaths: string[];
}

export interface AuthEventPayload {
  flowId: string;
  type: 'info' | 'auth_url' | 'device_code' | 'progress' | 'complete' | 'error';
  message?: string;
  url?: string;
  userCode?: string;
  verificationUri?: string;
}

/** Browser Bridge snapshot (lowered from @ev/browser-host to avoid a contracts -> browser-host cycle). */
export interface BrowserBridgePendingPairing {
  browserId: string;
  browserName: string;
  extensionVersion: string;
  origin: string;
  requestedAt: number;
}

/** One paired browser (a Chrome profile's extension) known to the Host. */
export interface BrowserBridgePairedBrowser {
  browserId: string;
  browserName: string | null;
  origin: string;
  online: boolean;
  connectedAt: number | null;
  lastSeenAt: number | null;
}

export interface BrowserBridgeSnapshot {
  /** Aggregate: 'connected' as soon as any paired browser is online. */
  status: 'stopped' | 'listening' | 'connected' | 'error';
  endpoint: string;
  pairedBrowsers: BrowserBridgePairedBrowser[];
  pendingPairings: BrowserBridgePendingPairing[];
  lastError: string | null;
}
