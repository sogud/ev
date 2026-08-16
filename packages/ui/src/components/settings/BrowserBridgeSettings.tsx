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
  onApprove(): void;
  onReject(): void;
  onRefresh(): void;
  onReconnect(): void;
  onRevoke(): void;
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
  const statusLabel = snapshot.pendingPairing
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
          {snapshot.status === 'connected' ? <ShieldCheck size={21} /> : <Cable size={21} />}
        </div>
        <div className='bridge-status-copy'>
          <strong>{statusLabel}</strong>
          <small>
            {snapshot.status === 'connected' ? t('bridge.authedNote') : t('bridge.localNote')}
          </small>
        </div>
        <span className={`bridge-status-pill ${snapshot.status}`}>{statusLabel}</span>
      </section>

      {snapshot.lastError && (
        <div className='bridge-error' role='alert'>
          {snapshot.lastError}
        </div>
      )}

      {snapshot.pendingPairing && (
        <section className='settings-group'>
          <h3>{t('bridge.pairingTitle', { name: snapshot.pendingPairing.browserName })}</h3>
          <div className='bridge-identity'>
            <strong>{t('bridge.pairingConfirm')}</strong>
            <code>{snapshot.pendingPairing.origin}</code>
            <small>
              {t('bridge.pairingMeta', { id: snapshot.pendingPairing.browserId })}{' '}
              {snapshot.pendingPairing.extensionVersion}
            </small>
          </div>
          <div className='bridge-actions'>
            <button className='primary-button compact' type='button' onClick={onApprove}>
              <Check size={15} /> {t('bridge.allow')}
            </button>
            <button className='bridge-revoke-button' type='button' onClick={onReject}>
              <X size={15} /> {t('bridge.deny')}
            </button>
          </div>
        </section>
      )}

      {snapshot.pairedOrigin && (
        <section className='settings-group'>
          <h3>{t('bridge.pairedTitle')}</h3>
          <div className='bridge-identity'>
            <strong>
              {snapshot.status === 'connected' ? t('bridge.online') : t('bridge.reconnecting')}
            </strong>
            <code>{snapshot.pairedOrigin}</code>
            {snapshot.browserId && <small>Browser ID · {snapshot.browserId}</small>}
          </div>
        </section>
      )}

      {!snapshot.pendingPairing && !snapshot.pairedOrigin && (
        <section className='settings-group'>
          <h3>{t('bridge.waitingTitle')}</h3>
          <p className='settings-note'>{t('bridge.waitingNote')}</p>
        </section>
      )}

      <div className='bridge-actions'>
        <button className='secondary-button compact' type='button' onClick={onRefresh}>
          <RefreshCw size={15} /> {t('bridge.refresh')}
        </button>
        <button className='secondary-button compact' type='button' onClick={onReconnect}>
          <RefreshCw size={15} /> {t('bridge.requestReconnect')}
        </button>
        {snapshot.pairedOrigin && (
          <button className='bridge-revoke-button' type='button' onClick={onRevoke}>
            <Unplug size={15} /> {t('bridge.unpair')}
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
      onApprove={() => void window.agentDesktop.browserBridge.approvePairing().then(setSnapshot)}
      onReject={() => void window.agentDesktop.browserBridge.rejectPairing().then(setSnapshot)}
      onRefresh={() => void window.agentDesktop.browserBridge.get().then(setSnapshot)}
      onReconnect={() => void window.agentDesktop.browserBridge.reconnect().then(setSnapshot)}
      onRevoke={() => {
        if (!window.confirm(t('bridge.unpairConfirm'))) return;
        void window.agentDesktop.browserBridge.revokePairing().then(setSnapshot);
      }}
    />
  );
}
