import { Cable, Check, RefreshCw, ShieldCheck, Unplug, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrowserBridgeSnapshot } from '../../../../shared/types';

const STATUS_LABELS: Record<BrowserBridgeSnapshot['status'], string> = {
  stopped: '已停止',
  listening: '等待连接',
  connected: '已连接',
  error: '启动失败',
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
  const statusLabel = snapshot.pendingPairing ? '等待批准' : STATUS_LABELS[snapshot.status];

  return (
    <div className='browser-bridge-settings settings-scroll'>
      <div className='settings-page-heading'>
        <h2>EV Browser</h2>
        <p>扩展会自动发现本机 Desktop；首次连接只需在这里批准一次。</p>
      </div>

      <section className='bridge-status-card' aria-live='polite'>
        <div className={`bridge-status-icon ${snapshot.status}`}>
          {snapshot.status === 'connected' ? <ShieldCheck size={21} /> : <Cable size={21} />}
        </div>
        <div className='bridge-status-copy'>
          <strong>{statusLabel}</strong>
          <small>
            {snapshot.status === 'connected'
              ? 'EV Browser 已通过认证，可以接收明确授权的浏览器操作。'
              : 'Desktop Bridge 只监听 127.0.0.1，并绑定已批准的扩展身份。'}
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
          <h3>{snapshot.pendingPairing.browserName} 请求连接</h3>
          <div className='bridge-identity'>
            <strong>确认这是你刚打开的 EV Browser 扩展</strong>
            <code>{snapshot.pendingPairing.origin}</code>
            <small>
              Browser ID · {snapshot.pendingPairing.browserId} · 扩展版本{' '}
              {snapshot.pendingPairing.extensionVersion}
            </small>
          </div>
          <div className='bridge-actions'>
            <button className='primary-button compact' type='button' onClick={onApprove}>
              <Check size={15} /> 允许连接
            </button>
            <button className='bridge-revoke-button' type='button' onClick={onReject}>
              <X size={15} /> 拒绝
            </button>
          </div>
        </section>
      )}

      {snapshot.pairedOrigin && (
        <section className='settings-group'>
          <h3>已配对浏览器</h3>
          <div className='bridge-identity'>
            <strong>{snapshot.status === 'connected' ? '当前在线' : '等待自动重连'}</strong>
            <code>{snapshot.pairedOrigin}</code>
            {snapshot.browserId && <small>Browser ID · {snapshot.browserId}</small>}
          </div>
        </section>
      )}

      {!snapshot.pendingPairing && !snapshot.pairedOrigin && (
        <section className='settings-group'>
          <h3>等待 EV Browser</h3>
          <p className='settings-note'>打开或重新加载扩展后，连接请求会自动出现在这里。</p>
        </section>
      )}

      <div className='bridge-actions'>
        <button className='secondary-button compact' type='button' onClick={onRefresh}>
          <RefreshCw size={15} /> 刷新状态
        </button>
        <button className='secondary-button compact' type='button' onClick={onReconnect}>
          <RefreshCw size={15} /> 请求重连
        </button>
        {snapshot.pairedOrigin && (
          <button className='bridge-revoke-button' type='button' onClick={onRevoke}>
            <Unplug size={15} /> 撤销配对
          </button>
        )}
      </div>
    </div>
  );
}

export function BrowserBridgeSettings(): React.JSX.Element {
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
          <p>正在读取本地连接状态…</p>
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
        if (!window.confirm('撤销后，EV Browser 需要重新批准才能连接。是否继续？')) return;
        void window.agentDesktop.browserBridge.revokePairing().then(setSnapshot);
      }}
    />
  );
}
