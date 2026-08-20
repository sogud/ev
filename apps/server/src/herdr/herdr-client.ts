import { execFile } from 'node:child_process';
import type { FleetAgentStatus, FleetPane, FleetSnapshot, FleetTab, FleetWorkspace } from '@ev/contracts';

/**
 * Thin wrapper around the local herdr CLI (shell-out + JSON parsing).
 *
 * Every call degrades instead of throwing: missing binary, herdr server down,
 * timeouts, non-zero exits, or unparseable output all resolve to null/false so
 * the fleet pipeline can fall back to "unavailable" or a stale snapshot. CLI
 * output is untrusted: only structural parsing, no eval of any content.
 */

export interface HerdrClientOptions {
  /** Explicit herdr binary path (tests inject fakes); defaults to `herdr` on PATH. */
  herdrPath?: string;
  /** Probe (`workspace list`) timeout; the probe must stay cheap. Default 3s. */
  probeTimeoutMs?: number;
  /** Timeout for regular commands (list/get/focus). Default 10s. */
  commandTimeoutMs?: number;
  /** Timeout for `pane read`, which snapshots terminal output. Default 10s. */
  readTimeoutMs?: number;
}

/** Result of `agent get <paneId>`: the contract agent triple plus pane cwd. */
export interface HerdrAgentInfo {
  name: string;
  kind: string;
  status: FleetAgentStatus;
  cwd?: string;
  paneId: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_READ_LINES = 60;
const MAX_READ_LINES = 500;
/** Pane lists / terminal reads can be large; keep a generous but bounded buffer. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** Herdr ids look like `w1`, `w1:t2`, `w1:pB`; reject anything else before exec. */
const HERDR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

export class HerdrClient {
  private readonly herdrPath: string;
  private readonly probeTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly readTimeoutMs: number;

  constructor(options: HerdrClientOptions = {}) {
    this.herdrPath = options.herdrPath?.trim() || 'herdr';
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  /** Cheap availability probe: `workspace list` within the probe timeout. */
  async probe(): Promise<boolean> {
    const result = parseEnvelope(await this.run(['workspace', 'list'], this.probeTimeoutMs));
    return Array.isArray(recordField(result, 'workspaces'));
  }

  /**
   * Full fleet tree: workspace list + per-workspace tab list + pane list.
   * Returns null only when the workspace list itself fails; a failed tab/pane
   * sub-list degrades to empty arrays so one bad workspace cannot sink the rest.
   */
  async listFleet(): Promise<FleetSnapshot | null> {
    const result = parseEnvelope(await this.run(['workspace', 'list'], this.commandTimeoutMs));
    const rawWorkspaces = recordField(result, 'workspaces');
    if (!Array.isArray(rawWorkspaces)) return null;
    const workspaces = await Promise.all(
      rawWorkspaces
        .filter(
          (workspace): workspace is Record<string, unknown> =>
            asRecord(workspace) && typeof workspace.workspace_id === 'string'
        )
        .map(async workspace => this.buildWorkspace(workspace))
    );
    return { available: true, fetchedAt: Date.now(), workspaces };
  }

  /** `agent get <paneId>`; null when the pane has no agent or herdr fails. */
  async getAgent(paneId: string): Promise<HerdrAgentInfo | null> {
    if (!isHerdrId(paneId)) return null;
    const result = parseEnvelope(
      await this.run(['agent', 'get', paneId], this.commandTimeoutMs)
    );
    const agentRaw = recordField(result, 'agent');
    if (!asRecord(agentRaw)) return null;
    const agent = agentRaw;
    const kind = typeof agent.agent === 'string' ? agent.agent : undefined;
    if (!kind) return null;
    return {
      name: typeof agent.name === 'string' && agent.name.length > 0 ? agent.name : kind,
      kind,
      status: normalizeAgentStatus(agent.agent_status),
      cwd: typeof agent.cwd === 'string' ? agent.cwd : undefined,
      paneId,
    };
  }

  /**
   * `pane read --source recent-unwrapped`: raw terminal text, on demand only —
   * never part of polling. Content is untrusted display data for the UI.
   */
  async readPane(paneId: string, lines: number = DEFAULT_READ_LINES): Promise<string | null> {
    if (!isHerdrId(paneId)) return null;
    const bounded = Math.min(Math.max(Math.trunc(lines), 1), MAX_READ_LINES);
    const stdout = await this.run(
      ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', String(bounded), '--format', 'text'],
      this.readTimeoutMs
    );
    return stdout === null ? null : stdout.replace(/\s+$/, '');
  }

  /**
   * Focus the pane's agent. The CLI's `pane focus` only moves by direction, so
   * the targeted form is `agent focus <paneId>` (v1's single write operation);
   * panes without an agent cannot be focused and resolve to false.
   */
  async focusPane(paneId: string): Promise<boolean> {
    if (!isHerdrId(paneId)) return false;
    const stdout = await this.run(['agent', 'focus', paneId], this.commandTimeoutMs);
    return parseEnvelope(stdout) !== null;
  }

  private async buildWorkspace(raw: Record<string, unknown>): Promise<FleetWorkspace> {
    const workspaceId = raw.workspace_id as string;
    const [tabs, panes] = await Promise.all([
      this.listTabs(workspaceId),
      this.listPanes(workspaceId),
    ]);
    const panesByTab = new Map<string, FleetPane[]>();
    for (const pane of panes) {
      const list = panesByTab.get(pane.tabId) ?? [];
      list.push(pane.pane);
      panesByTab.set(pane.tabId, list);
    }
    return {
      workspaceId,
      name: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : undefined,
      tabs: tabs.map(tab => ({ tabId: tab.tabId, label: tab.label, panes: panesByTab.get(tab.tabId) ?? [] })),
    };
  }

  private async listTabs(
    workspaceId: string
  ): Promise<Array<{ tabId: string; label?: string }>> {
    const result = parseEnvelope(
      await this.run(['tab', 'list', '--workspace', workspaceId], this.commandTimeoutMs)
    );
    const rawTabs = recordField(result, 'tabs');
    if (!Array.isArray(rawTabs)) return [];
    return rawTabs
      .filter(asRecord)
      .filter(tab => typeof tab.tab_id === 'string')
      .map(tab => ({
        tabId: tab.tab_id as string,
        label: typeof tab.label === 'string' && tab.label.length > 0 ? tab.label : undefined,
      }));
  }

  private async listPanes(
    workspaceId: string
  ): Promise<Array<{ tabId: string; pane: FleetPane }>> {
    const result = parseEnvelope(
      await this.run(['pane', 'list', '--workspace', workspaceId], this.commandTimeoutMs)
    );
    const rawPanes = recordField(result, 'panes');
    if (!Array.isArray(rawPanes)) return [];
    const panes: Array<{ tabId: string; pane: FleetPane }> = [];
    for (const raw of rawPanes) {
      if (!asRecord(raw)) continue;
      const paneId = typeof raw.pane_id === 'string' ? raw.pane_id : undefined;
      const tabId = typeof raw.tab_id === 'string' ? raw.tab_id : undefined;
      if (!paneId || !tabId) continue;
      const kind = typeof raw.agent === 'string' && raw.agent.length > 0 ? raw.agent : undefined;
      panes.push({
        tabId,
        pane: {
          paneId,
          title: firstString(raw.terminal_title_stripped, raw.terminal_title),
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
          agent: kind
            ? {
                name: firstString(raw.agent_name) ?? kind,
                kind,
                status: normalizeAgentStatus(raw.agent_status),
              }
            : undefined,
        },
      });
    }
    return panes;
  }

  /** Never throws: missing binary, timeout, non-zero exit all resolve to null. */
  private run(args: string[], timeoutMs: number): Promise<string | null> {
    return new Promise(resolve => {
      execFile(
        this.herdrPath,
        args,
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER_BYTES },
        (error, stdout) => {
          resolve(error ? null : String(stdout));
        }
      );
    });
  }
}

function isHerdrId(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && HERDR_ID_PATTERN.test(value);
}

function normalizeAgentStatus(value: unknown): FleetAgentStatus {
  return value === 'idle' || value === 'working' || value === 'blocked' || value === 'done'
    ? value
    : 'unknown';
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * herdr CLI envelope: `{"id":..., "result":{...}}` on success,
 * `{"id":..., "error":{...}}` (non-zero exit) on failure.
 */
function parseEnvelope(stdout: string | null): Record<string, unknown> | null {
  if (stdout === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!asRecord(parsed)) return null;
  return asRecord(parsed.result) ? parsed.result : null;
}

function recordField(record: Record<string, unknown> | null, key: string): unknown {
  return record ? record[key] : undefined;
}
