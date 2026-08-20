import type { FleetSnapshot } from '@ev/contracts';
import { useEffect, useState } from 'react';
import { findFleetPane } from '../fleet-view-model';
import { FleetDrawer, type FleetPaneLoad } from './FleetDrawer';
import { FleetView } from './FleetView';

/**
 * Fleet data container (herdr-fleet-v1): pulls the last snapshot over
 * `fleet:get`, follows `fleet:update` pushes from the server's poll loop, and
 * owns the pane-output drawer state.
 *
 * Pane output is lazy and on-demand: selecting a pane triggers a single
 * `fleet:readPane` pull (never part of polling); switching panes re-fetches;
 * closing the drawer returns to the tree. Snapshot pushes re-render the tree
 * but never re-trigger an output pull.
 */
export function FleetPanel(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [load, setLoad] = useState<FleetPaneLoad>({ status: 'loading' });

  useEffect(() => {
    const offUpdate = window.agentDesktop.fleet.onUpdate(next => setSnapshot(next));
    // Initial pull; the push channel converges any race. A failed pull (server
    // still booting) leaves the loading state until a push arrives.
    window.agentDesktop.fleet
      .get()
      .then(setSnapshot)
      .catch(() => undefined);
    return offUpdate;
  }, []);

  // Lazy output pull keyed on the selection. Re-runs (re-fetches) on pane
  // switch; the cleanup drops stale responses from a fast pane switch so a slow
  // read for pane A cannot overwrite pane B's output.
  useEffect(() => {
    if (!selectedPaneId) return;
    let cancelled = false;
    window.agentDesktop.fleet
      .readPane(selectedPaneId)
      .then(result => {
        if (cancelled) return;
        if (result.ok) setLoad({ status: 'ready', output: result.output ?? '' });
        else setLoad({ status: 'error', error: result.error ?? '' });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoad({
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPaneId]);

  const selectedPane = findFleetPane(snapshot, selectedPaneId);

  return (
    <div className='fleet-layout'>
      <FleetView
        snapshot={snapshot}
        selectedPaneId={selectedPaneId}
        onSelectPane={paneId => {
          // Re-clicking the open pane is a no-op (no redundant pull); the
          // loading state is set here so the drawer never flashes the
          // previous pane's output while the new read is in flight.
          if (paneId === selectedPaneId) return;
          setSelectedPaneId(paneId);
          setLoad({ status: 'loading' });
        }}
      />
      {selectedPane && (
        <FleetDrawer
          pane={selectedPane}
          load={load}
          onClose={() => setSelectedPaneId(null)}
        />
      )}
    </div>
  );
}
