import { Dialog } from '@base-ui/react/dialog';
import { Cable, ChevronRight, Cpu, FolderOpen, Settings, X } from 'lucide-react';
import { useState } from 'react';
import type { RuntimeDescriptor } from '../../../shared/types';
import { useAppStore } from '../store/useAppStore';
import { BrowserBridgeSettings } from './settings/BrowserBridgeSettings';
import { GeneralSettings } from './settings/GeneralSettings';
import { ResourceSettings } from './settings/ResourceSettings';

type Tab = 'browser' | 'general' | 'runtimes';

/*
 * Runtime 页=紧凑行列表+抽屉详情（2026-08-09 重设计）：
 * 行四列等构（glyph/name+version/状态徽章/能力chips/chevron），整行 button 键盘可达；
 * 抽屉=认证说明+配置路径打开+模型目录只读；pi 抽屉另含能力与资源管理。
 * EV 零凭据持有：打开走系统编辑器，复制只到剪贴板，绝不代写原生配置。
 */
function statusTextOf(runtime: RuntimeDescriptor): string {
  const auth = runtime.auth;
  if (auth?.status === 'logged_in') return `已登录${auth.account ? `（${auth.account}）` : ''}`;
  if (auth?.status === 'logged_out') return '未登录';
  return '无法确定';
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
  const [copied, setCopied] = useState(false);
  const providers = useAppStore(state => state.providers);
  const auth = runtime.auth;
  return (
    <aside className='runtime-drawer' aria-label={`${runtime.name} 详情`}>
      <header>
        <span className='runtime-glyph' aria-hidden='true'>
          {runtime.glyph ?? runtime.id.slice(0, 2)}
        </span>
        <strong>{runtime.name}</strong>
        {runtime.version && <span className='muted'>v{runtime.version}</span>}
        <span className={`auth-status ${runtime.auth?.status ?? 'unknown'}`}>
          {statusTextOf(runtime)}
        </span>
        <button type='button' className='icon-button' aria-label='关闭详情' onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <section>
        <h3>原生认证</h3>
        <p className='muted'>{auth?.hint ?? '凭据由该 runtime 原生管理，EV 只读展示。'}</p>
        {auth?.loginCommand && (
          <button
            type='button'
            className='ghost-button'
            onClick={() => {
              copyText(auth.loginCommand ?? '');
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}>
            {copied ? '已复制' : `复制登录命令：${auth.loginCommand}`}
          </button>
        )}
      </section>
      {auth?.configPaths && auth.configPaths.length > 0 && (
        <section>
          <h3>配置文件（只读）</h3>
          {auth.configPaths.map(path => (
            <span key={path} className='auth-path'>
              <code title={path}>{path.replace(/^\/Users\/[^/]+/, '~')}</code>
              <button
                type='button'
                className='icon-button'
                aria-label={`打开 ${path}`}
                onClick={() => void window.agentDesktop.settings.openPath(path)}>
                <FolderOpen size={13} />
              </button>
            </span>
          ))}
        </section>
      )}
      <section>
        <h3>模型目录（只读）</h3>
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
                  {provider.name} · {provider.models.filter(model => model.available).length} 个可用
                </li>
              ))}
          </ul>
        ) : (
          <p className='muted'>以原生为准</p>
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
      aria-label={`${runtime.name} 详情`}
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
        {chip('模型', caps.models)}
        {chip('思考', caps.thinkingLevels)}
        {chip('续话', caps.resumeSession)}
      </span>
      <ChevronRight size={15} className='row-chevron' aria-hidden='true' />
    </button>
  );
}

function RuntimesPage(): React.JSX.Element {
  const runtimes = useAppStore(state => state.runtimes);
  const [openId, setOpenId] = useState<string | null>(null);
  const openRuntime = runtimes.find(runtime => runtime.id === openId);
  return (
    <div className='runtimes-page'>
      <div className='settings-page-heading'>
        <h2>Runtime</h2>
        <p>原生认证只读展示；点行查看认证、配置与模型目录。</p>
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
          <Dialog.Description className='sr-only'>管理 EV 的运行时与界面设置</Dialog.Description>
          <aside className='settings-nav'>
            <Dialog.Title className='settings-nav-title'>设置</Dialog.Title>
            {navButton('general', <Settings size={16} />, '通用')}
            {navButton('runtimes', <Cpu size={16} />, 'Runtime')}
            {navButton('browser', <Cable size={16} />, 'Browser')}
          </aside>
          <div className='settings-content'>
            <Dialog.Close className='modal-close icon-button' aria-label='关闭设置'>
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
