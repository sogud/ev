import { FolderOpen } from 'lucide-react';
import type { ThemePreference } from '../../../../shared/types';
import { useAppStore } from '../../store/useAppStore';
import { MenuPicker } from '../ui/MenuPicker';
import { ModelPicker } from '../ui/ModelPicker';
import { RuntimePicker } from '../ui/RuntimePicker';
import { ThinkingPicker } from '../ui/ThinkingPicker';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

export function GeneralSettings(): React.JSX.Element {
  const settings = useAppStore(state => state.settings);
  const providers = useAppStore(state => state.providers);
  const runtimes = useAppStore(state => state.runtimes);
  const update = useAppStore(state => state.updateSettings);
  if (!settings) return <div />;

  const chooseDirectory = async (): Promise<void> => {
    const path = await window.agentDesktop.settings.chooseDirectory();
    if (path) await update({ defaultWorkspace: path });
  };

  const modelValue =
    settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : '';

  return (
    <div className='general-settings settings-scroll'>
      <div className='settings-page-heading'>
        <h2>通用</h2>
        <p>设置新任务的默认目录、模型和思考强度。</p>
      </div>
      <section className='settings-group'>
        <h3>外观</h3>
        <div className='setting-row'>
          <span>
            <strong>主题</strong>
            <small>切换浅色、深色或跟随 macOS</small>
          </span>
          <MenuPicker
            className='settings-picker'
            value={settings.theme}
            options={THEME_OPTIONS}
            ariaLabel='界面主题'
            onValueChange={theme => void update({ theme })}
          />
        </div>
      </section>
      <section className='settings-group'>
        <h3>工作区</h3>
        <button className='path-picker' type='button' onClick={() => void chooseDirectory()}>
          <FolderOpen size={18} />
          <span>
            <strong>默认目录</strong>
            <small>{settings.defaultWorkspace}</small>
          </span>
          <em>更改</em>
        </button>
      </section>
      <section className='settings-group'>
        <h3>新任务默认值</h3>
        <div className='setting-row'>
          <span>
            <strong>默认 Runtime</strong>
            <small>Pi 或外部 Agent CLI</small>
          </span>
          <RuntimePicker
            className='settings-picker'
            runtimes={runtimes}
            value={settings.defaultRuntime}
            onValueChange={defaultRuntime => void update({ defaultRuntime })}
          />
        </div>
        <div className='setting-row'>
          <span>
            <strong>默认模型</strong>
            <small>新建任务时优先使用</small>
          </span>
          <ModelPicker
            className='settings-picker'
            providers={providers}
            value={modelValue}
            onValueChange={(provider, model) =>
              void update({ defaultProvider: provider, defaultModel: model })
            }
          />
        </div>
        <div className='setting-row'>
          <span>
            <strong>思考强度</strong>
            <small>支持 reasoning 的模型会使用</small>
          </span>
          <ThinkingPicker
            className='settings-picker'
            value={settings.defaultThinkingLevel}
            onValueChange={defaultThinkingLevel => void update({ defaultThinkingLevel })}
          />
        </div>
      </section>
      <section className='settings-group about-block'>
        <h3>关于</h3>
        <div>
          <span className='provider-avatar'>EV</span>
          <span>
            <strong>EV</strong>
            <small>Enhanced Vigilance · 个人桌面 Agent · 0.1.0</small>
          </span>
        </div>
      </section>
    </div>
  );
}
