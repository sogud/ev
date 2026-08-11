import { AlertCircle, X } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatPanel } from './components/ChatPanel';
import { EvMark } from './components/EvMark';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { useAppStore } from './store/useAppStore';

export default function App(): React.JSX.Element {
  const store = useAppStore();
  const { t } = useTranslation();

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;
    void store.initialize().then(cleanup => {
      if (active) unsubscribe = cleanup;
      else cleanup();
    });
    const offResync = window.agentDesktop.onResynced(() => {
      void useAppStore.getState().refreshAfterResync();
    });
    return () => {
      active = false;
      unsubscribe?.();
      offResync();
    };
  }, []);

  useEffect(() => {
    const theme = store.settings?.theme;
    if (!theme || theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
  }, [store.settings?.theme]);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.metaKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void store.createTask();
      }
      if (event.metaKey && event.key === ',') {
        event.preventDefault();
        store.openSettings(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (store.loading)
    return (
      <div className='app-loading'>
        <EvMark />
      </div>
    );

  if (!store.settings) {
    return (
      <div className='app-loading'>
        <p>{t('app.loadError')}</p>
        {store.error && <p className='app-error-detail'>{store.error}</p>}
        <button type='button' className='ghost-button' onClick={() => window.location.reload()}>
          {t('app.retry')}
        </button>
      </div>
    );
  }

  const selectedModel = store.detail?.model
    ? `${store.detail.model.provider}/${store.detail.model.id}`
    : store.settings.defaultProvider && store.settings.defaultModel
      ? `${store.settings.defaultProvider}/${store.settings.defaultModel}`
      : '';
  const thinkingLevel = store.detail?.thinkingLevel ?? store.settings.defaultThinkingLevel;

  // The only runtime switch lives under the composer (sidebar is display-only):
  // - canSwitch = no task, or the task has zero messages; locked after the first send;
  // - onRuntime routes to task-level setTaskRuntime when a free task exists, else the global default.
  const canSwitch = !store.detail || store.detail.messages.length === 0;
  return (
    <div className='app-shell'>
      <Sidebar
        tasks={store.tasks}
        selectedId={store.selectedId}
        defaultWorkspace={store.settings.defaultWorkspace}
        runtimes={store.runtimes}
        onSelect={id => void store.selectTask(id)}
        onCreate={() => void store.createTask()}
        onRemove={id => void store.removeTask(id)}
        onSettings={() => store.openSettings(true)}
      />
      <ChatPanel
        task={store.detail}
        providers={store.providers}
        runtimes={store.runtimes}
        canSwitch={canSwitch}
        selectedModel={selectedModel}
        runtimeId={
          store.detail?.runtime?.runtimeId ??
          store.detail?.pendingRuntimeId ??
          store.selectedRuntimeId
        }
        thinkingLevel={thinkingLevel}
        defaultWorkspace={store.settings.defaultWorkspace ?? ''}
        onCreate={() => void store.createTask()}
        onSend={prompt => void store.sendPrompt(prompt)}
        onAbort={() => void store.abort()}
        onModel={(provider, model) => {
          if (store.detail) void store.setModel(provider, model);
          else void store.updateSettings({ defaultProvider: provider, defaultModel: model });
        }}
        onThinking={level => {
          if (store.detail) void store.setThinkingLevel(level);
          else void store.updateSettings({ defaultThinkingLevel: level });
        }}
        onRuntime={id => {
          if (store.detail && store.detail.messages.length === 0) {
            void store.setTaskRuntime(store.detail.id, id);
          } else if (!store.detail) {
            store.selectRuntime(id);
          }
        }}
      />
      {store.settingsOpen && <SettingsModal onClose={() => store.openSettings(false)} />}
      {store.error && (
        <div className='error-toast' role='alert'>
          <AlertCircle size={17} />
          <span>{store.error}</span>
          <button type='button' aria-label={t('app.closeErrorAria')} onClick={store.clearError}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
