import type { FleetSnapshot } from '@ev/contracts';
import { useEffect, useState } from 'react';
import { FleetView } from './FleetView';

/**
 * Fleet data container (herdr-fleet-v1): pulls the last snapshot over
 * `fleet:get`, then follows `fleet:update` pushes from the server's poll loop.
 * Render-only: all presentation decisions live in FleetView/buildFleetView.
 */
export function FleetPanel(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);

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

  return <FleetView snapshot={snapshot} />;
}
