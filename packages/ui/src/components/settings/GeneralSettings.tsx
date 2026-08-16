import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ThemePreference } from '../../shared/types';
import { useAppStore } from '../../store/useAppStore';
import { MenuPicker } from '../ui/MenuPicker';
import { ModelPicker } from '../ui/ModelPicker';
import { RuntimePicker } from '../ui/RuntimePicker';
import { ThinkingPicker } from '../ui/ThinkingPicker';

export function GeneralSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const settings = useAppStore(state => state.settings);
  const providers = useAppStore(state => state.providers);
  const runtimes = useAppStore(state => state.runtimes);
  const update = useAppStore(state => state.updateSettings);
  if (!settings) return <div />;

  const themeOptions: Array<{ value: ThemePreference; label: string }> = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ];
  const languageOptions = [
    { value: 'system', label: t('settings.languageSystem') },
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
  ];

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
        <h2>{t('settings.general')}</h2>
        <p>{t('settings.generalDesc')}</p>
      </div>
      <section className='settings-group'>
        <h3>{t('settings.appearance')}</h3>
        <div className='setting-row'>
          <span>
            <strong>{t('settings.theme')}</strong>
            <small>{t('settings.themeDesc')}</small>
          </span>
          <MenuPicker
            className='settings-picker'
            testId='picker-theme'
            value={settings.theme}
            options={themeOptions}
            ariaLabel={t('settings.theme')}
            onValueChange={theme => void update({ theme })}
          />
        </div>
        <div className='setting-row'>
          <span>
            <strong>{t('settings.language')}</strong>
            <small>{t('settings.languageDesc')}</small>
          </span>
          <MenuPicker
            className='settings-picker'
            testId='picker-language'
            value={settings.language ?? 'system'}
            options={languageOptions}
            ariaLabel={t('settings.language')}
            onValueChange={language =>
              void update({ language: language === 'system' ? null : (language as 'en' | 'zh') })
            }
          />
        </div>
      </section>
      <section className='settings-group'>
        <h3>{t('settings.workspace')}</h3>
        <button className='path-picker' type='button' onClick={() => void chooseDirectory()}>
          <FolderOpen size={18} />
          <span>
            <strong>{t('settings.defaultWorkspace')}</strong>
            <small>{settings.defaultWorkspace}</small>
          </span>
          <em>{t('settings.change')}</em>
        </button>
      </section>
      <section className='settings-group'>
        <h3>{t('settings.defaults')}</h3>
        <div className='setting-row'>
          <span>
            <strong>{t('settings.defaultRuntime')}</strong>
            <small>{t('settings.defaultRuntimeDesc')}</small>
          </span>
          <RuntimePicker
            className='settings-picker'
            testId='picker-runtime'
            runtimes={runtimes}
            value={settings.defaultRuntime}
            onValueChange={defaultRuntime => void update({ defaultRuntime })}
          />
        </div>
        <div className='setting-row'>
          <span>
            <strong>{t('settings.defaultModel')}</strong>
            <small>{t('settings.defaultModelDesc')}</small>
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
            <strong>{t('settings.defaultThinking')}</strong>
            <small>{t('settings.defaultThinkingDesc')}</small>
          </span>
          <ThinkingPicker
            className='settings-picker'
            value={settings.defaultThinkingLevel}
            onValueChange={defaultThinkingLevel => void update({ defaultThinkingLevel })}
          />
        </div>
      </section>
      <section className='settings-group about-block'>
        <h3>{t('settings.about')}</h3>
        <div>
          <span className='provider-avatar'>EV</span>
          <span>
            <strong>EV</strong>
            <small>{t('settings.aboutDesc')}</small>
          </span>
        </div>
      </section>
    </div>
  );
}
