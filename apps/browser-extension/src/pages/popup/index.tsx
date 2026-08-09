import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Bookmark, ExternalLink, MonitorCog, RefreshCw, Settings } from 'lucide-react';
import { applyThemePreference } from '../../utils/apply-settings';

import '../../globals.css';

interface CurrentTab {
  title: string;
  url: string;
}

type BridgeStatus = 'disabled' | 'connecting' | 'pairing' | 'connected' | 'disconnected';

const BRIDGE_STATUS_LABEL: Record<BridgeStatus, string> = {
  disabled: 'Not enabled',
  connecting: 'Connecting',
  pairing: 'Waiting for pairing',
  connected: 'Connected',
  disconnected: 'Disconnected',
};

function Popup() {
  const [currentTab, setCurrentTab] = useState<CurrentTab>({ title: '', url: '' });
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>('disabled');

  useEffect(() => {
    void Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      chrome.runtime.sendMessage({ action: 'bridge.status' }),
      chrome.storage.sync.get({ theme: 'auto' }),
    ]).then(([tabs, bridge, appearance]) => {
      const tab = tabs[0];
      setCurrentTab({ title: tab?.title ?? 'Current page', url: tab?.url ?? '' });
      if (
        ['disabled', 'connecting', 'pairing', 'connected', 'disconnected'].includes(bridge?.status)
      ) {
        setBridgeStatus(bridge.status as BridgeStatus);
      }
      applyThemePreference(appearance.theme as 'auto' | 'light' | 'dark');
    });
  }, []);

  const hostname = (() => {
    try {
      return currentTab.url ? new URL(currentTab.url).hostname : '';
    } catch {
      return '';
    }
  })();

  const reconnect = async () => {
    setBridgeStatus('connecting');
    const response = await chrome.runtime.sendMessage({ action: 'bridge.reconnect' });
    if (response?.status) setBridgeStatus(response.status as BridgeStatus);
  };

  const statusColor =
    bridgeStatus === 'connected'
      ? 'var(--ev-color-status-success)'
      : bridgeStatus === 'disabled'
        ? 'var(--ev-color-status-warning)'
        : 'var(--ev-color-status-info)';

  return (
    <main className='ev-popup'>
      <header className='ev-popup-header'>
        <div className='ev-popup-mark'>
          <Bookmark size={16} />
        </div>
        <div>
          <h1 className='ev-popup-title'>EV Browser</h1>
          <div className='ev-popup-subtitle'>Browser context & local agent</div>
        </div>
      </header>

      <section className='ev-popup-current'>
        <strong>{currentTab.title}</strong>
        <small>{hostname || currentTab.url}</small>
      </section>

      <div className='ev-popup-status'>
        <span className='flex items-center gap-2'>
          <MonitorCog size={14} /> Browser Host
        </span>
        <span className='ev-popup-status-actions' style={{ color: statusColor }}>
          {BRIDGE_STATUS_LABEL[bridgeStatus]}
          <button
            type='button'
            className='ev-popup-reconnect'
            title='Request reconnect'
            aria-label='Request reconnect'
            onClick={() => void reconnect()}>
            <RefreshCw size={13} />
          </button>
        </span>
      </div>

      <div className='ev-popup-actions'>
        <button className='ev-button ev-button-primary' onClick={() => void chrome.tabs.create({})}>
          <ExternalLink size={13} /> New tab
        </button>
        <button
          className='ev-button ev-button-outline'
          onClick={() => void chrome.runtime.openOptionsPage()}>
          <Settings size={13} /> Settings
        </button>
      </div>
    </main>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<Popup />);
