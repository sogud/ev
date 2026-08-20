import type { FleetAgentStatus, FleetPane, FleetSnapshot } from '@ev/contracts';

/**
 * Expression-layer view-model mapper for the Herdr fleet view
 * (spec: herdr-fleet-v1). Pure function: FleetSnapshot -> presentation
 * structure. Blocked panes are the headline: they are sorted to the front of
 * their tab and counted so the UI can badge them.
 */

/** Presentation tone per pane; mirrors FleetAgentStatus plus the no-agent case. */
export type FleetStatusTone = FleetAgentStatus;

export interface FleetPaneView {
  paneId: string;
  /** title with a paneId fallback so every row has a headline. */
  title: string;
  cwd?: string;
  agentName?: string;
  agentKind?: string;
  /** 'unknown' when the pane has no detected agent. */
  status: FleetStatusTone;
}

export interface FleetTabView {
  tabId: string;
  /** label with a tabId fallback. */
  label: string;
  /** Blocked panes first; otherwise server order is preserved. */
  panes: FleetPaneView[];
}

export interface FleetWorkspaceView {
  workspaceId: string;
  /** name with a workspaceId fallback. */
  name: string;
  tabs: FleetTabView[];
  blockedCount: number;
}

export type FleetView =
  | { state: 'unavailable' }
  | {
      state: 'ready';
      stale: boolean;
      fetchedAt: number;
      paneCount: number;
      workingCount: number;
      blockedCount: number;
      workspaces: FleetWorkspaceView[];
    };

/**
 * Locate a raw pane by id within a snapshot (workspace → tab → pane). Used by
 * the drawer container to pull header metadata for the selected pane. Returns
 * undefined when the snapshot is still loading or the pane has since closed.
 */
export function findFleetPane(
  snapshot: FleetSnapshot | null,
  paneId: string | null
): FleetPane | undefined {
  if (!snapshot || !paneId) return undefined;
  for (const workspace of snapshot.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        if (pane.paneId === paneId) return pane;
      }
    }
  }
  return undefined;
}

function paneView(pane: FleetPane): FleetPaneView {
  return {
    paneId: pane.paneId,
    title: pane.title?.trim() || pane.paneId,
    cwd: pane.cwd || undefined,
    agentName: pane.agent?.name || undefined,
    agentKind: pane.agent?.kind || undefined,
    status: pane.agent?.status ?? 'unknown',
  };
}

/** Stable partition: blocked panes first, everything else keeps input order. */
function blockedFirst(panes: FleetPaneView[]): FleetPaneView[] {
  return [
    ...panes.filter(pane => pane.status === 'blocked'),
    ...panes.filter(pane => pane.status !== 'blocked'),
  ];
}

export function buildFleetView(snapshot: FleetSnapshot): FleetView {
  if (!snapshot.available) return { state: 'unavailable' };

  let paneCount = 0;
  let workingCount = 0;
  let blockedCount = 0;
  const workspaces = snapshot.workspaces.map(workspace => {
    const tabs = workspace.tabs.map(tab => {
      const panes = blockedFirst(tab.panes.map(paneView));
      paneCount += panes.length;
      for (const pane of panes) {
        if (pane.status === 'working') workingCount += 1;
        if (pane.status === 'blocked') blockedCount += 1;
      }
      return { tabId: tab.tabId, label: tab.label?.trim() || tab.tabId, panes };
    });
    return {
      workspaceId: workspace.workspaceId,
      name: workspace.name?.trim() || workspace.workspaceId,
      tabs,
      blockedCount: tabs.reduce((sum, tab) => {
        return sum + tab.panes.filter(pane => pane.status === 'blocked').length;
      }, 0),
    };
  });

  return {
    state: 'ready',
    stale: snapshot.stale ?? false,
    fetchedAt: snapshot.fetchedAt,
    paneCount,
    workingCount,
    blockedCount,
    workspaces,
  };
}
