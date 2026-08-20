import type { FleetSnapshot } from '@ev/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { FleetView, type FleetViewProps } from './FleetView';

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

  it('renders pane rows as selectable buttons with no selection by default', () => {
    const markup = renderToStaticMarkup(<FleetView snapshot={snapshot({})} />);
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain('fleet-pane-selected');
  });

  it('highlights exactly one pane row when selectedPaneId matches', () => {
    const markup = renderToStaticMarkup(
      <FleetView snapshot={snapshot({})} selectedPaneId='pane-2' />
    );
    expect(markup.split('fleet-pane-selected').length - 1).toBe(1);
    expect(markup.split('aria-pressed="true"').length - 1).toBe(1);
  });

  it('does not highlight when selectedPaneId matches no pane', () => {
    const markup = renderToStaticMarkup(
      <FleetView snapshot={snapshot({})} selectedPaneId='ghost' />
    );
    expect(markup).not.toContain('fleet-pane-selected');
    expect(markup).not.toContain('aria-pressed="true"');
  });

  describe('Focus action (ticket 04)', () => {
    // Wrapped in I18nextProvider so translated feedback text is asserted (zh pinned in setup).
    const render = (props: FleetViewProps): string =>
      renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <FleetView {...props} />
        </I18nextProvider>
      );

    it('renders a focus button on agent panes only, separate from the row button', () => {
      const markup = render({ snapshot: snapshot({}) });
      // exactly one focus button: pane-2 has an agent, pane-1 does not
      expect(markup.split('fleet-focus-button').length - 1).toBe(1);
      expect(markup).toContain('aria-label="在 Herdr 中聚焦该 pane"');
      // the row stays the drawer-opening control; the focus control is a real <button>
      expect(markup).toContain('role="button"');
      expect(markup).toMatch(/<button type="button" class="fleet-focus-button icon-button"/);
    });

    it('shows pending feedback on the targeted pane and disables its button', () => {
      const markup = render({
        snapshot: snapshot({}),
        focus: { paneId: 'pane-2', status: 'pending' },
      });
      expect(markup).toContain('disabled');
      expect(markup).toContain('聚焦中');
      expect(markup).toContain('spin');
    });

    it('shows success feedback on the targeted pane only', () => {
      const markup = render({
        snapshot: snapshot({}),
        focus: { paneId: 'pane-2', status: 'success' },
      });
      expect(markup).toContain('fleet-focus-success');
      expect(markup).toContain('已聚焦');
      expect(markup).not.toContain('fleet-focus-error');
    });

    it('shows the server error text on failure', () => {
      const markup = render({
        snapshot: snapshot({}),
        focus: { paneId: 'pane-2', status: 'error', error: 'pane closed' },
      });
      expect(markup).toContain('fleet-focus-error');
      expect(markup).toContain('pane closed');
    });

    it('falls back to the generic focus error when the message is empty', () => {
      const markup = render({
        snapshot: snapshot({}),
        focus: { paneId: 'pane-2', status: 'error', error: '' },
      });
      expect(markup).toContain('聚焦失败');
    });

    it('ignores focus feedback for a pane that no longer exists in the snapshot', () => {
      const markup = render({
        snapshot: snapshot({}),
        focus: { paneId: 'ghost', status: 'error', error: 'boom' },
      });
      expect(markup).not.toContain('fleet-focus-error');
      expect(markup).not.toContain('boom');
    });

    it('keeps focus feedback independent from the drawer selection highlight', () => {
      const markup = render({
        snapshot: snapshot({}),
        selectedPaneId: 'pane-1',
        focus: { paneId: 'pane-2', status: 'success' },
      });
      // selection stays on pane-1, feedback renders on pane-2
      expect(markup.split('fleet-pane-selected').length - 1).toBe(1);
      expect(markup).toContain('fleet-focus-success');
    });
  });
});
