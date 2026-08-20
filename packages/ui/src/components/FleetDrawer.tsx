import type { FleetPane } from '@ev/contracts';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Lazy-load state for one pane's output. Owned by the FleetPanel container,
 * which performs the on-demand `fleet.readPane` pull; the drawer itself is a
 * pure render so every state is reachable from tests/static markup.
 */
export type FleetPaneLoad =
  { status: 'loading' } | { status: 'ready'; output: string } | { status: 'error'; error: string };

export interface FleetDrawerProps {
  pane: FleetPane;
  load: FleetPaneLoad;
  onClose: () => void;
}

/**
 * Pane output drawer (herdr-fleet-v1). Renders a pane's recent raw terminal
 * output. The output is untrusted data: it is rendered as plain text inside a
 * <pre> (React escapes it), never parsed for links and never executed. The
 * "raw terminal output" notice stays visible in every state.
 */
export function FleetDrawer({ pane, load, onClose }: FleetDrawerProps): React.JSX.Element {
  const { t } = useTranslation();
  const title = pane.title?.trim() || pane.paneId;
  const agent = pane.agent
    ? pane.agent.kind && pane.agent.kind !== pane.agent.name
      ? `${pane.agent.name} · ${pane.agent.kind}`
      : pane.agent.name
    : undefined;

  return (
    <aside className='fleet-drawer' aria-label={t('fleet.drawer.aria')}>
      <header className='fleet-drawer-header'>
        <div className='fleet-drawer-heading'>
          <span className='fleet-drawer-title'>{title}</span>
          {(agent || pane.cwd) && (
            <span className='fleet-drawer-sub'>
              {agent}
              {agent && pane.cwd ? ' · ' : ''}
              {pane.cwd}
            </span>
          )}
        </div>
        <button
          type='button'
          className='icon-button'
          aria-label={t('fleet.drawer.closeAria')}
          onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className='fleet-drawer-notice'>{t('fleet.drawer.untrusted')}</div>
      <div className='fleet-drawer-body'>
        {load.status === 'loading' && (
          <div className='fleet-drawer-status'>{t('fleet.drawer.loading')}</div>
        )}
        {load.status === 'error' && (
          <div className='fleet-drawer-status fleet-drawer-error'>
            {load.error || t('fleet.drawer.errorFallback')}
          </div>
        )}
        {load.status === 'ready' &&
          (load.output.trim() === '' ? (
            <div className='fleet-drawer-status'>{t('fleet.drawer.empty')}</div>
          ) : (
            <pre className='fleet-drawer-output'>{load.output}</pre>
          ))}
      </div>
    </aside>
  );
}
