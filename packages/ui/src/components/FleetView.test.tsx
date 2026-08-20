import type { FleetSnapshot } from '@ev/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FleetView } from './FleetView';

function snapshot(partial: Partial<FleetSnapshot>): FleetSnapshot {
  return {
    available: true,
    fetchedAt: 1_700_000_000_000,
    workspaces: [
      {
        workspaceId: 'ws-1',
        name: 'agentspace',
        tabs: [
          {
            tabId: 'tab-1',
            label: 'main',
            panes: [
              { paneId: 'pane-1', title: 'ticket 02', cwd: '/tmp/ev' },
              {
                paneId: 'pane-2',
                title: 'supervisor',
                cwd: '/tmp/ev',
                agent: { name: 'pi', kind: 'pi', status: 'blocked' },
              },
            ],
          },
        ],
      },
    ],
    ...partial,
  };
}

describe('FleetView', () => {
  it('renders the loading state before the first snapshot', () => {
    const markup = renderToStaticMarkup(<FleetView snapshot={null} />);
    expect(markup).toContain('fleet-view');
    expect(markup).toContain('fleet-empty');
    expect(markup).not.toContain('fleet-tree');
  });

  it('renders only the one-line empty state when herdr is unavailable', () => {
    const markup = renderToStaticMarkup(
      <FleetView snapshot={{ available: false, fetchedAt: 0, workspaces: [] }} />
    );
    expect(markup).toContain('fleet-empty');
    expect(markup).not.toContain('fleet-tree');
    expect(markup).not.toContain('fleet-pane');
  });

  it('renders the tree with status classes and blocked panes first', () => {
    const markup = renderToStaticMarkup(<FleetView snapshot={snapshot({})} />);
    expect(markup).toContain('fleet-tree');
    expect(markup).toContain('agentspace');
    expect(markup).toContain('main');
    expect(markup).toContain('ticket 02');
    // blocked pane surfaces first with its tone class + header badge
    expect(markup.indexOf('fleet-status-blocked')).toBeLessThan(
      markup.indexOf('fleet-status-unknown')
    );
    expect(markup).toContain('fleet-chip-blocked');
    // agent meta renders on agent panes only
    expect(markup).toContain('pi · pi');
    expect(markup).toContain('/tmp/ev');
  });

  it('flags stale snapshots in the header', () => {
    const markup = renderToStaticMarkup(<FleetView snapshot={snapshot({ stale: true })} />);
    expect(markup).toContain('fleet-stale');
  });
});
