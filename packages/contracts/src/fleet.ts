import { z } from 'zod';

/**
 * FleetSnapshot (herdr-fleet-v1): the EV server's read-only view of the local
 * Herdr fleet — workspace → tab → pane → agent. Source data comes from the
 * herdr CLI and is untrusted: the server only does structural parsing, and the
 * schema bounds every string so a hostile/malformed CLI output cannot balloon
 * payloads pushed over client-sync.
 */

export const FleetAgentStatusSchema = z.enum(['idle', 'working', 'blocked', 'done', 'unknown']);

export type FleetAgentStatus = z.infer<typeof FleetAgentStatusSchema>;

export const FleetAgentSchema = z.object({
  name: z.string().max(512),
  /** Agent runtime kind reported by Herdr (e.g. pi / codex / claude). */
  kind: z.string().max(512),
  status: FleetAgentStatusSchema,
});

export type FleetAgent = z.infer<typeof FleetAgentSchema>;

export const FleetPaneSchema = z.object({
  paneId: z.string().min(1).max(512),
  title: z.string().max(512).optional(),
  cwd: z.string().max(4096).optional(),
  /** Absent for panes without a detected agent. */
  agent: FleetAgentSchema.optional(),
});

export type FleetPane = z.infer<typeof FleetPaneSchema>;

export const FleetTabSchema = z.object({
  tabId: z.string().min(1).max(512),
  label: z.string().max(512).optional(),
  panes: z.array(FleetPaneSchema),
});

export type FleetTab = z.infer<typeof FleetTabSchema>;

export const FleetWorkspaceSchema = z.object({
  workspaceId: z.string().min(1).max(512),
  name: z.string().max(512).optional(),
  tabs: z.array(FleetTabSchema),
});

export type FleetWorkspace = z.infer<typeof FleetWorkspaceSchema>;

export const FleetSnapshotSchema = z.object({
  /** False when Herdr is missing/not running; workspaces is then empty. */
  available: z.boolean(),
  /** Epoch ms when the server fetched this snapshot (0 = never fetched). */
  fetchedAt: z.number(),
  /** Reserved: true when the snapshot may be outdated (degraded fetch). */
  stale: z.boolean().optional(),
  workspaces: z.array(FleetWorkspaceSchema),
});

export type FleetSnapshot = z.infer<typeof FleetSnapshotSchema>;

/**
 * On-demand read of one pane's recent raw terminal output
 * (`fleet:readPane`, herdr-fleet-v1). Fetched lazily on click — never part of
 * polling — and treated as untrusted display data: the UI renders it as plain
 * text and never executes or link-parses it. `output` is bounded so a
 * hostile/oversized CLI read cannot balloon the response payload.
 */
export const FleetPaneReadSchema = z.object({
  ok: z.boolean(),
  /** Raw terminal text; empty string is a valid "pane has no output" success. */
  output: z.string().max(4_000_000).optional(),
  /** Present when ok=false: a short, UI-safe reason (pane closed, herdr down). */
  error: z.string().max(1024).optional(),
});

export type FleetPaneRead = z.infer<typeof FleetPaneReadSchema>;
