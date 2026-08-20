import { describe, expect, it } from 'vitest';
import type { FleetSnapshot } from '@ev/contracts';
import { buildFleetView } from './fleet-view-model';

function snapshot(partial: Partial<FleetSnapshot>): FleetSnapshot {
  return { available: true, fetchedAt: 1_700_000_000_000, workspaces: [], ...partial };
}

describe('buildFleetView', () => {
  it('collapses an unavailable herdr into the empty state without any structure', () => {
    const view = buildFleetView(snapshot({ available: false, fetchedAt: 0 }));
    expect(view).toEqual({ state: 'unavailable' });
  });

  it('maps the workspace -> tab -> pane tree with display fallbacks', () => {
    const view = buildFleetView(
      snapshot({
        workspaces: [
          {
            workspaceId: 'ws-1',
            name: ' ',
            tabs: [
              {
                tabId: 'tab-1',
                panes: [
                  {
                    paneId: 'pane-1',
                    title: 'fix the fleet',
                    cwd: '/tmp/ev',
                    agent: { name: 'pi-agent', kind: 'pi', status: 'working' },
                  },
                  { paneId: 'pane-2' },
                ],
              },
            ],
          },
        ],
      })
    );

    expect(view.state).toBe('ready');
    if (view.state !== 'ready') return;
    const workspace = view.workspaces[0];
    // blank name falls back to the id
    expect(workspace.name).toBe('ws-1');
    expect(workspace.tabs[0].label).toBe('tab-1');
    const [first, second] = workspace.tabs[0].panes;
    expect(first).toMatchObject({
      paneId: 'pane-1',
      title: 'fix the fleet',
      cwd: '/tmp/ev',
      agentName: 'pi-agent',
      agentKind: 'pi',
      status: 'working',
    });
    // agent-less panes render as unknown with the paneId as title
    expect(second).toMatchObject({ paneId: 'pane-2', title: 'pane-2', status: 'unknown' });
    expect(second.cwd).toBeUndefined();
    expect(second.agentName).toBeUndefined();
  });

  it('sorts blocked panes to the front of their tab', () => {
    const view = buildFleetView(
      snapshot({
        workspaces: [
          {
            workspaceId: 'ws-1',
            tabs: [
              {
                tabId: 'tab-1',
                panes: [
                  { paneId: 'a', agent: { name: 'x', kind: 'pi', status: 'working' } },
                  { paneId: 'b', agent: { name: 'y', kind: 'codex', status: 'blocked' } },
                  { paneId: 'c', agent: { name: 'z', kind: 'pi', status: 'idle' } },
                  { paneId: 'd', agent: { name: 'w', kind: 'pi', status: 'blocked' } },
                ],
              },
            ],
          },
        ],
      })
    );

    if (view.state !== 'ready') throw new Error('expected ready');
    expect(view.workspaces[0].tabs[0].panes.map(pane => pane.paneId)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
    expect(view.workspaces[0].blockedCount).toBe(2);
  });

  it('counts panes by status across workspaces and carries stale/fetchedAt', () => {
    const view = buildFleetView(
      snapshot({
        stale: true,
        fetchedAt: 42,
        workspaces: [
          {
            workspaceId: 'ws-1',
            tabs: [
              {
                tabId: 't',
                panes: [
                  { paneId: 'a', agent: { name: 'x', kind: 'pi', status: 'working' } },
                  { paneId: 'b', agent: { name: 'y', kind: 'pi', status: 'done' } },
                ],
              },
            ],
          },
          {
            workspaceId: 'ws-2',
            tabs: [
              { tabId: 't', panes: [{ paneId: 'c' }] },
              { tabId: 'u', panes: [] },
            ],
          },
        ],
      })
    );

    if (view.state !== 'ready') throw new Error('expected ready');
    expect(view).toMatchObject({
      state: 'ready',
      stale: true,
      fetchedAt: 42,
      paneCount: 3,
      workingCount: 1,
      blockedCount: 0,
    });
  });

  it('keeps every agent status tone distinct for the color legend', () => {
    const statuses = ['idle', 'working', 'blocked', 'done', 'unknown'] as const;
    const view = buildFleetView(
      snapshot({
        workspaces: [
          {
            workspaceId: 'ws',
            tabs: [
              {
                tabId: 't',
                panes: statuses.map((status, index) => ({
                  paneId: `p-${index}`,
                  agent: { name: 'a', kind: 'pi', status },
                })),
              },
            ],
          },
        ],
      })
    );

    if (view.state !== 'ready') throw new Error('expected ready');
    // blocked floats to the front; the rest keep order
    const seen = view.workspaces[0].tabs[0].panes.map(pane => pane.status);
    expect(seen).toEqual(['blocked', 'idle', 'working', 'done', 'unknown']);
    expect(new Set(seen).size).toBe(statuses.length);
  });
});
