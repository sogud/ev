import { Dialog } from '@base-ui/react/dialog';
import { Cable, ChevronRight, Cpu, FolderOpen, Settings, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { i18n } from '../i18n';
import type { RuntimeDescriptor } from '../../../shared/types';
import { useAppStore } from '../store/useAppStore';
import { BrowserBridgeSettings } from './settings/BrowserBridgeSettings';
import { GeneralSettings } from './settings/GeneralSettings';
import { ResourceSettings } from './settings/ResourceSettings';

type Tab = 'browser' | 'general' | 'runtimes';

/*
 * Runtimes page = compact row list + drawer detail:
 * rows are four-column (glyph / name+version / status badge / capability chips / chevron),
 * whole row is a keyboard-reachable button; drawer shows auth hints, read-only config
 * paths and the read-only model catalog; the pi drawer adds capabilities and resources.
 * EV holds zero credentials: opens go through the system editor, copies hit the
 * clipboard only, native configs are never written by EV.
 */
function statusTextOf(runtime: RuntimeDescriptor): string {
  const auth = runtime.auth;
  if (auth?.status === 'logged_in')
    return i18n.t('runtimes.loggedIn', { suffix: auth.account ? ` (${auth.account})` : '' });
  if (auth?.status === 'logged_out') return i18n.t('common.loggedOut');
  return i18n.t('runtimes.authUnknown');
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text);
}

function RuntimeDrawer({
  runtime,
  onClose,
}: {
  runtime: RuntimeDescriptor;
  onClose(): void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const providers = useAppStore(state => state.providers);
  const auth = runtime.auth;
  return (
    <aside className='runtime-drawer' aria-label={t('runtimes.drawerAria', { name: runtime.name })}>
      <header>
        <span className='runtime-glyph' aria-hidden='true'>
          {runtime.glyph ?? runtime.id.slice(0, 2)}
        </span>
        <strong>{runtime.name}</strong>
        {runtime.version && <span className='muted'>v{runtime.version}</span>}
        <span className={`auth-status ${runtime.auth?.status ?? 'unknown'}`}>
          {statusTextOf(runtime)}
        </span>
        <button
          type='button'
          className='icon-button'
          aria-label={t('runtimes.closeDrawerAria')}
          onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <section>
        <h3>{t('runtimes.nativeAuth')}</h3>
        <p className='muted'>{auth?.hint ?? t('runtimes.authHint')}</p>
        {auth?.loginCommand && (
          <button
            type='button'
            className='ghost-button'
            onClick={() => {
              copyText(auth.loginCommand ?? '');
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}>
            {copied
              ? t('runtimes.copied')
              : t('runtimes.copyLogin', { command: auth.loginCommand })}
          </button>
        )}
      </section>
      {auth?.configPaths && auth.configPaths.length > 0 && (
        <section>
          <h3>{t('runtimes.configFiles')}</h3>
          {auth.configPaths.map(path => (
            <span key={path} className='auth-path'>
              <code title={path}>{path.replace(/^\/Users\/[^/]+/, '~')}</code>
              <button
                type='button'
                className='icon-button'
                aria-label={t('runtimes.openAria', { path })}
                onClick={() => void window.agentDesktop.settings.openPath(path)}>
                <FolderOpen size={13} />
              </button>
            </span>
          ))}
        </section>
      )}
      <section>
        <h3>{t('runtimes.modelCatalog')}</h3>
        {runtime.modelCatalog && runtime.modelCatalog.length > 0 ? (
          <ul className='drawer-model-list'>
            {runtime.modelCatalog.map(model => (
              <li key={model.id}>{model.name}</li>
            ))}
          </ul>
        ) : runtime.id === 'pi' ? (
          <ul className='drawer-model-list'>
            {providers
              .filter(provider => provider.models.some(model => model.available))
              .map(provider => (
                <li key={provider.id}>
                  {provider.name} ·{' '}
                  {t('runtimes.modelsAvailable', {
                    count: provider.models.filter(model => model.available).length,
                  })}
                </li>
              ))}
          </ul>
        ) : (
          <p className='muted'>{t('runtimes.nativeSource')}</p>
        )}
      </section>
      {runtime.id === 'pi' && <ResourceSettings />}
    </aside>
  );
}

function RuntimeRow({
  runtime,
  open,
  onToggle,
}: {
  runtime: RuntimeDescriptor;
  open: boolean;
  onToggle(): void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const caps = runtime.capabilities;
  const chip = (label: string, on: boolean): React.JSX.Element => (
    <span key={label} className={`cap-chip${on ? '' : ' off'}`}>
      {label}
    </span>
  );
  return (
    <button
      type='button'
      className={`runtime-row${open ? ' open' : ''}`}
      aria-expanded={open}
      aria-label={t('runtimes.drawerAria', { name: runtime.name })}
      onClick={onToggle}>
      <span className='runtime-glyph' aria-hidden='true'>
        {runtime.glyph ?? runtime.id.slice(0, 2)}
      </span>
      <span className='runtime-row-name'>
        <strong>{runtime.name}</strong>
        {runtime.version && <span className='muted'>v{runtime.version}</span>}
      </span>
      <span className={`auth-status ${runtime.auth?.status ?? 'unknown'}`}>
        {statusTextOf(runtime)}
      </span>
      <span className='cap-chips'>
        {chip(t('runtimes.capsModels'), caps.models)}
        {chip(t('runtimes.capsThinking'), caps.thinkingLevels)}
        {chip(t('runtimes.capsResume'), caps.resumeSession)}
      </span>
      <ChevronRight size={15} className='row-chevron' aria-hidden='true' />
    </button>
  );
}

function RuntimesPage(): React.JSX.Element {
  const { t } = useTranslation();
  const runtimes = useAppStore(state => state.runtimes);
  const [openId, setOpenId] = useState<string | null>(null);
  const openRuntime = runtimes.find(runtime => runtime.id === openId);
  return (
    <div className='runtimes-page'>
      <div className='settings-page-heading'>
        <h2>Runtime</h2>
        <p>{t('runtimes.pageDesc')}</p>
      </div>
      <div className='runtime-rows' role='list'>
        {runtimes.map(runtime => (
          <RuntimeRow
            key={runtime.id}
            runtime={runtime}
            open={openId === runtime.id}
            onToggle={() => setOpenId(value => (value === runtime.id ? null : runtime.id))}
          />
        ))}
      </div>
      {openRuntime && <RuntimeDrawer runtime={openRuntime} onClose={() => setOpenId(null)} />}
    </div>
  );
}

export function SettingsModal({ onClose }: { onClose(): void }): React.JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('general');

  const navButton = (value: Tab, icon: React.ReactNode, label: string): React.JSX.Element => (
    <button
      className={tab === value ? 'active' : ''}
      type='button'
      aria-current={tab === value ? 'page' : undefined}
      onClick={() => setTab(value)}>
      {icon}
      {label}
    </button>
  );

  return (
    <Dialog.Root open onOpenChange={open => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className='modal-backdrop' />
        <Dialog.Popup className='settings-modal'>
          <Dialog.Description className='sr-only'>{t('runtimes.dialogDesc')}</Dialog.Description>
          <aside className='settings-nav'>
            <Dialog.Title className='settings-nav-title'>{t('settings.title')}</Dialog.Title>
            {navButton('general', <Settings size={16} />, t('settings.general'))}
            {navButton('runtimes', <Cpu size={16} />, 'Runtime')}
            {navButton('browser', <Cable size={16} />, 'Browser')}
          </aside>
          <div className='settings-content'>
            <Dialog.Close
              className='modal-close icon-button'
              aria-label={t('runtimes.closeSettingsAria')}>
              <X size={18} />
            </Dialog.Close>
            {tab === 'general' && <GeneralSettings />}
            {tab === 'runtimes' && <RuntimesPage />}
            {tab === 'browser' && <BrowserBridgeSettings />}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
