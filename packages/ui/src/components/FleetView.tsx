import type { FleetSnapshot } from '@ev/contracts';
import { Crosshair, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  buildFleetView,
  type FleetFocusFeedback,
  type FleetStatusTone,
} from '../fleet-view-model';

const STATUS_LABEL_KEY: Record<FleetStatusTone, string> = {
  working: 'fleet.statusWorking',
  blocked: 'fleet.statusBlocked',
  done: 'fleet.statusDone',
  idle: 'fleet.statusIdle',
  unknown: 'fleet.statusUnknown',
};

export interface FleetViewProps {
  snapshot: FleetSnapshot | null;
  /** Currently selected pane (drives the output drawer); null = none. */
  selectedPaneId?: string | null;
  /** Fired when a pane row is clicked/activated; the container opens the drawer. */
  onSelectPane?: (paneId: string) => void;
  /**
   * Fired from the per-pane Focus button only (never from the row click);
   * the container issues `fleet:focusPane`. Focus is the fleet's single write
   * operation and stays clearly separate from the drawer-opening row click.
   */
  onFocusPane?: (paneId: string) => void;
  /** Transient focus feedback for one pane at a time; null = idle. */
  focus?: FleetFocusFeedback | null;
}

/**
 * Pure render of the Herdr fleet tree (herdr-fleet-v1 prototype). Data flows in
 * as a FleetSnapshot; buildFleetView does every presentation decision (blocked
 * first, counts, fallbacks). `snapshot === null` = first fetch still pending.
 * Pane rows are selectable so the container can open the output drawer.
 */
export function FleetView({
  snapshot,
  selectedPaneId,
  onSelectPane,
  onFocusPane,
  focus,
}: FleetViewProps): React.JSX.Element {
  const { t } = useTranslation();

  if (!snapshot) {
    return (
      <div className='fleet-view'>
        <div className='fleet-empty'>{t('fleet.loading')}</div>
      </div>
    );
  }

  const view = buildFleetView(snapshot);
  if (view.state === 'unavailable') {
    return (
      <div className='fleet-view'>
        <div className='fleet-empty'>{t('fleet.unavailable')}</div>
      </div>
    );
  }

  return (
    <div className='fleet-view'>
      <header className='fleet-header'>
        <span className='fleet-title'>{t('fleet.title')}</span>
        {view.blockedCount > 0 && (
          <span className='fleet-chip fleet-chip-blocked'>
            {t('fleet.blockedCount', { count: view.blockedCount })}
          </span>
        )}
        {view.workingCount > 0 && (
          <span className='fleet-chip fleet-chip-working'>
            {t('fleet.workingCount', { count: view.workingCount })}
          </span>
        )}
        <span className='fleet-meta'>
          {view.stale && <span className='fleet-stale'>{t('fleet.stale')}</span>}
          {view.fetchedAt > 0 &&
            t('fleet.updated', { time: new Date(view.fetchedAt).toLocaleTimeString() })}
        </span>
      </header>
      <div className='fleet-tree'>
        {view.paneCount === 0 && <p className='fleet-empty'>{t('fleet.emptyFleet')}</p>}
        {view.workspaces.map(workspace => (
          <section className='fleet-workspace' key={workspace.workspaceId}>
            <div className='fleet-workspace-name'>
              <span>{workspace.name}</span>
              {workspace.blockedCount > 0 && (
                <span className='fleet-chip fleet-chip-blocked'>
                  {t('fleet.blockedCount', { count: workspace.blockedCount })}
                </span>
              )}
            </div>
            {workspace.tabs.map(tab => (
              <div className='fleet-tab' key={tab.tabId}>
                <div className='fleet-tab-label'>{tab.label}</div>
                {tab.panes.map(pane => {
                  const selected = pane.paneId === selectedPaneId;
                  const paneFocus = focus?.paneId === pane.paneId ? focus : null;
                  return (
                    <div
                      className={`fleet-pane fleet-status-${pane.status}${
                        selected ? ' fleet-pane-selected' : ''
                      }`}
                      key={pane.paneId}
                      title={pane.cwd ?? pane.paneId}
                      role='button'
                      tabIndex={0}
                      aria-pressed={selected}
                      onClick={() => onSelectPane?.(pane.paneId)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelectPane?.(pane.paneId);
                        }
                      }}>
                      <span
                        className='fleet-status-dot'
                        aria-label={t(STATUS_LABEL_KEY[pane.status])}
                      />
                      <span className='fleet-pane-title'>{pane.title}</span>
                      {pane.agentName && (
                        <span className='fleet-pane-agent'>
                          {pane.agentName}
                          {pane.agentKind ? ` · ${pane.agentKind}` : ''}
                        </span>
                      )}
                      {pane.cwd && <span className='fleet-pane-cwd'>{pane.cwd}</span>}
                      {pane.agentKind && (
                        <button
                          type='button'
                          className='fleet-focus-button icon-button'
                          aria-label={t('fleet.focusAria')}
                          disabled={paneFocus?.status === 'pending'}
                          onClick={event => {
                            // Focus is a write action, not a drawer open:
                            // keep the row's select handler out of it.
                            event.stopPropagation();
                            onFocusPane?.(pane.paneId);
                          }}
                          onKeyDown={event => {
                            // The row listens for Enter/Space; don't let the
                            // button's activation also open the drawer.
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.stopPropagation();
                            }
                          }}>
                          {paneFocus?.status === 'pending' ? (
                            <LoaderCircle size={14} className='spin' />
                          ) : (
                            <Crosshair size={14} />
                          )}
                        </button>
                      )}
                      {paneFocus?.status === 'pending' && (
                        <span className='fleet-focus-status'>{t('fleet.focusing')}</span>
                      )}
                      {paneFocus?.status === 'success' && (
                        <span className='fleet-focus-status fleet-focus-success'>
                          {t('fleet.focused')}
                        </span>
                      )}
                      {paneFocus?.status === 'error' && (
                        <span className='fleet-focus-status fleet-focus-error'>
                          {paneFocus.error || t('fleet.focusError')}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
