import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { Bookmark, ExternalLink, MonitorCog, RefreshCw, Settings } from 'lucide-react';
import { applyLanguagePreference, i18n } from '../../i18n';
import { applyThemePreference } from '../../utils/apply-settings';

import '../../globals.css';

interface CurrentTab {
  title: string;
  url: string;
}

type BridgeStatus = 'disabled' | 'connecting' | 'pairing' | 'connected' | 'disconnected';

function Popup() {
  const { t } = useTranslation();
  const [currentTab, setCurrentTab] = useState<CurrentTab>({ title: '', url: '' });
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>('disabled');

  useEffect(() => {
    void Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      chrome.runtime.sendMessage({ action: 'bridge.status' }),
      chrome.storage.sync.get({ theme: 'auto', language: 'system' }),
    ]).then(([tabs, bridge, appearance]) => {
      const tab = tabs[0];
      setCurrentTab({ title: tab?.title ?? '', url: tab?.url ?? '' });
      if (
        ['disabled', 'connecting', 'pairing', 'connected', 'disconnected'].includes(bridge?.status)
      ) {
        setBridgeStatus(bridge.status as BridgeStatus);
      }
      applyThemePreference(appearance.theme as 'auto' | 'light' | 'dark');
      void applyLanguagePreference(appearance.language as 'system' | 'en' | 'zh');
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
          <div className='ev-popup-subtitle'>{t('browser.popup.subtitle')}</div>
        </div>
      </header>

      <section className='ev-popup-current'>
        <strong>{currentTab.title || t('browser.popup.currentPage')}</strong>
        <small>{hostname || currentTab.url}</small>
      </section>

      <div className='ev-popup-status'>
        <span className='flex items-center gap-2'>
          <MonitorCog size={14} /> {t('browser.popup.browserHost')}
        </span>
        <span className='ev-popup-status-actions' style={{ color: statusColor }}>
          {t(`browser.status.${bridgeStatus}`)}
          <button
            type='button'
            className='ev-popup-reconnect'
            title={t('browser.popup.requestReconnect')}
            aria-label={t('browser.popup.requestReconnect')}
            onClick={() => void reconnect()}>
            <RefreshCw size={13} />
          </button>
        </span>
      </div>

      <div className='ev-popup-actions'>
        <button className='ev-button ev-button-primary' onClick={() => void chrome.tabs.create({})}>
          <ExternalLink size={13} /> {t('browser.popup.newTab')}
        </button>
        <button
          className='ev-button ev-button-outline'
          onClick={() => void chrome.runtime.openOptionsPage()}>
          <Settings size={13} /> {t('browser.popup.settings')}
        </button>
      </div>
    </main>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <I18nextProvider i18n={i18n}>
    <Popup />
  </I18nextProvider>
);
