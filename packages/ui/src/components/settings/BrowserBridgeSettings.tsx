import { Cable, Check, RefreshCw, ShieldCheck, Unplug, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BrowserBridgeSnapshot } from '../../shared/types';

// Resolved at render time so a runtime language switch re-renders correctly.
const STATUS_LABEL_KEYS: Record<BrowserBridgeSnapshot['status'], string> = {
  stopped: 'bridge.statusStopped',
  listening: 'bridge.statusListening',
  connected: 'bridge.statusConnected',
  error: 'bridge.statusError',
};

interface BrowserBridgeContentProps {
  snapshot: BrowserBridgeSnapshot;
  onApprove(browserId: string): void;
  onReject(browserId: string): void;
  onRefresh(): void;
  onReconnect(browserId?: string): void;
  onRevoke(browserId?: string): void;
}

export function BrowserBridgeContent({
  snapshot,
  onApprove,
  onReject,
  onRefresh,
  onReconnect,
  onRevoke,
}: BrowserBridgeContentProps): React.JSX.Element {
  const { t } = useTranslation();
  const onlineCount = snapshot.pairedBrowsers.filter(browser => browser.online).length;
  const statusLabel = snapshot.pendingPairings.length
    ? t('bridge.statusPendingPairing')
    : t(STATUS_LABEL_KEYS[snapshot.status]);

  return (
    <div className='browser-bridge-settings settings-scroll'>
      <div className='settings-page-heading'>
        <h2>EV Browser</h2>
        <p>{t('bridge.desc')}</p>
      </div>

      <section className='bridge-status-card' aria-live='polite'>
        <div className={`bridge-status-icon ${snapshot.status}`}>
          {onlineCount > 0 ? <ShieldCheck size={21} /> : <Cable size={21} />}
        </div>
        <div className='bridge-status-copy'>
          <strong>{statusLabel}</strong>
          <small>
            {onlineCount > 0
              ? t('bridge.onlineCount', { count: onlineCount })
              : t('bridge.localNote')}
          </small>
        </div>
        <span className={`bridge-status-pill ${snapshot.status}`}>{statusLabel}</span>
      </section>

      {snapshot.lastError && (
        <div className='bridge-error' role='alert'>
          {snapshot.lastError}
        </div>
      )}

      {snapshot.pendingPairings.map(pending => (
        <section className='settings-group' key={pending.browserId}>
          <h3>{t('bridge.pairingTitle', { name: pending.browserName })}</h3>
          <div className='bridge-identity'>
            <strong>{t('bridge.pairingConfirm')}</strong>
            <code>{pending.origin}</code>
            <small>
              {t('bridge.pairingMeta', { id: pending.browserId })} {pending.extensionVersion}
            </small>
          </div>
          <div className='bridge-actions'>
            <button
              className='primary-button compact'
              type='button'
              onClick={() => onApprove(pending.browserId)}>
              <Check size={15} /> {t('bridge.allow')}
            </button>
            <button
              className='bridge-revoke-button'
              type='button'
              onClick={() => onReject(pending.browserId)}>
              <X size={15} /> {t('bridge.deny')}
            </button>
          </div>
        </section>
      ))}

      {snapshot.pairedBrowsers.length > 0 && (
        <section className='settings-group'>
          <h3>{t('bridge.pairedTitle')}</h3>
          {snapshot.pairedBrowsers.map(browser => (
            <div className='bridge-identity' key={browser.browserId}>
              <strong>
                {browser.online ? t('bridge.online') : t('bridge.reconnecting')}
                {browser.browserName ? ` · ${browser.browserName}` : ''}
              </strong>
              <code>{browser.origin}</code>
              <small>Browser ID · {browser.browserId}</small>
              <button
                className='bridge-revoke-button'
                type='button'
                onClick={() => {
                  if (!window.confirm(t('bridge.unpairConfirm'))) return;
                  onRevoke(browser.browserId);
                }}>
                <Unplug size={15} /> {t('bridge.unpair')}
              </button>
            </div>
          ))}
        </section>
      )}

      {!snapshot.pendingPairings.length && snapshot.pairedBrowsers.length === 0 && (
        <section className='settings-group'>
          <h3>{t('bridge.waitingTitle')}</h3>
          <p className='settings-note'>{t('bridge.waitingNote')}</p>
        </section>
      )}

      <div className='bridge-actions'>
        <button className='secondary-button compact' type='button' onClick={onRefresh}>
          <RefreshCw size={15} /> {t('bridge.refresh')}
        </button>
        <button className='secondary-button compact' type='button' onClick={() => onReconnect()}>
          <RefreshCw size={15} /> {t('bridge.requestReconnect')}
        </button>
        {snapshot.pairedBrowsers.length > 1 && (
          <button
            className='bridge-revoke-button'
            type='button'
            onClick={() => {
              if (!window.confirm(t('bridge.unpairAllConfirm'))) return;
              onRevoke();
            }}>
            <Unplug size={15} /> {t('bridge.unpairAll')}
          </button>
        )}
      </div>
    </div>
  );
}

export function BrowserBridgeSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<BrowserBridgeSnapshot | null>(null);

  useEffect(() => {
    void window.agentDesktop.browserBridge.get().then(setSnapshot);
    return window.agentDesktop.browserBridge.onUpdate(setSnapshot);
  }, []);

  if (!snapshot) {
    return (
      <div className='browser-bridge-settings settings-scroll' aria-busy='true'>
        <div className='settings-page-heading'>
          <h2>EV Browser</h2>
          <p>{t('bridge.reading')}</p>
        </div>
      </div>
    );
  }

  return (
    <BrowserBridgeContent
      snapshot={snapshot}
      onApprove={browserId =>
        void window.agentDesktop.browserBridge.approvePairing(browserId).then(setSnapshot)
      }
      onReject={browserId =>
        void window.agentDesktop.browserBridge.rejectPairing(browserId).then(setSnapshot)
      }
      onRefresh={() => void window.agentDesktop.browserBridge.get().then(setSnapshot)}
      onReconnect={browserId =>
        void window.agentDesktop.browserBridge.reconnect(browserId).then(setSnapshot)
      }
      onRevoke={browserId =>
        void window.agentDesktop.browserBridge.revokePairing(browserId).then(setSnapshot)
      }
    />
  );
}
