import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { MenuPicker } from '../../components/ui/menu-picker';
import { DEFAULT_OPTIONS, type Options as OptionsType } from '../../types';
import { Cable, Download, Image as ImageIcon, Palette, Settings, Trash2 } from 'lucide-react';
import { applyLanguagePreference, i18n } from '../../i18n';
import { applyCustomSettings, applyThemePreference } from '../../utils/apply-settings';
import {
  readBackgroundImageFile,
  readSavedBackgroundImage,
  removeBackgroundImage,
  saveBackgroundImage,
  type SavedBackgroundImage,
} from '../../shared/background-image';
import '../../globals.css';

type BridgeStatus = 'disabled' | 'connecting' | 'pairing' | 'connected' | 'disconnected';

const BRIDGE_STATUSES: BridgeStatus[] = [
  'disabled',
  'connecting',
  'pairing',
  'connected',
  'disconnected',
];

function isBridgeStatus(value: unknown): value is BridgeStatus {
  return typeof value === 'string' && BRIDGE_STATUSES.includes(value as BridgeStatus);
}

export const OptionsPage = () => {
  const { t } = useTranslation();
  const [options, setOptions] = useState<OptionsType>(DEFAULT_OPTIONS);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>('connecting');
  const [backgroundImage, setBackgroundImage] = useState<SavedBackgroundImage | null>(null);
  const [status, setStatus] = useState('');
  const backgroundFileRef = useRef<HTMLInputElement>(null);
  const languageOptions: Array<{ value: OptionsType['language']; label: string }> = [
    { value: 'system', label: t('browser.options.languageSystem') },
    { value: 'en', label: t('browser.options.languageEnglish') },
    { value: 'zh', label: t('browser.options.languageChinese') },
  ];
  const themeOptions: Array<{ value: OptionsType['theme']; label: string }> = [
    { value: 'auto', label: t('browser.options.themeSystem') },
    { value: 'light', label: t('browser.options.themeLight') },
    { value: 'dark', label: t('browser.options.themeDark') },
  ];
  const sortOptions: Array<{ value: OptionsType['sortBy']; label: string }> = [
    { value: 'name', label: t('browser.options.sortName') },
    { value: 'date', label: t('browser.options.sortDate') },
    { value: 'url', label: t('browser.options.sortUrl') },
  ];

  useEffect(() => {
    void Promise.all([
      chrome.storage.sync.get(DEFAULT_OPTIONS),
      chrome.runtime.sendMessage({ action: 'bridge.status' }),
      readSavedBackgroundImage(),
    ]).then(([appearance, bridgeState, savedBackground]) => {
      setOptions(appearance as OptionsType);
      if (bridgeState?.success && isBridgeStatus(bridgeState.status)) {
        setBridgeStatus(bridgeState.status);
      }
      setBackgroundImage(savedBackground);
    });
  }, []);

  useEffect(() => {
    applyThemePreference(options.theme);
    void applyLanguagePreference(options.language);
  }, [options.language, options.theme]);

  const selectBackgroundImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const savedBackground = await readBackgroundImageFile(file);
      const background: OptionsType['background'] = {
        type: 'image',
        value: 'local',
        opacity: options.background.type === 'image' ? options.background.opacity : 100,
      };
      await saveBackgroundImage(savedBackground);
      await chrome.storage.sync.set({ background });
      setBackgroundImage(savedBackground);
      setOptions(current => ({ ...current, background }));
      setStatus(t('browser.options.imageApplied'));
    } catch (error) {
      if (!(error instanceof Error)) {
        setStatus(t('browser.options.imageReadError'));
      } else if (error.message === 'Please choose an image file') {
        setStatus(t('browser.options.imageTypeError'));
      } else if (error.message === 'Background image must be under 4 MB') {
        setStatus(t('browser.options.imageSizeError'));
      } else {
        setStatus(t('browser.options.imageReadError'));
      }
    }
  };

  const clearBackgroundImage = async () => {
    const background: OptionsType['background'] = {
      type: 'color',
      value: 'transparent',
      opacity: 100,
    };
    await removeBackgroundImage();
    await chrome.storage.sync.set({ background });
    setBackgroundImage(null);
    setOptions(current => ({ ...current, background }));
    setStatus(t('browser.options.imageCleared'));
  };

  const refreshBridgeStatus = async () => {
    const response = await chrome.runtime.sendMessage({ action: 'bridge.status' });
    if (response?.success && isBridgeStatus(response.status)) {
      setBridgeStatus(response.status);
    }
  };

  const reconnectBridge = async () => {
    const response = await chrome.runtime.sendMessage({ action: 'bridge.reconnect' });
    if (response?.success && isBridgeStatus(response.status)) {
      setBridgeStatus(response.status);
    }
  };

  const saveOptions = async () => {
    await chrome.storage.sync.set(options);
    applyCustomSettings(options);
    setStatus(t('browser.options.saved'));
    window.setTimeout(() => setStatus(''), 2000);
  };

  return (
    <main className='ev-options-page'>
      <div className='ev-options-shell'>
        <header className='ev-page-header'>
          <h1 className='ev-page-title'>
            <Settings size={18} /> {t('browser.options.title')}
          </h1>
          <p className='ev-page-description'>{t('browser.options.description')}</p>
        </header>

        <div className='ev-settings-stack'>
          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2'>
                <Palette size={15} /> {t('browser.options.appearance')}
              </CardTitle>
              <CardDescription>{t('browser.options.appearanceDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className='ev-setting-row'>
                <div className='ev-setting-copy'>
                  <strong>{t('browser.options.language')}</strong>
                  <small>{t('browser.options.languageDesc')}</small>
                </div>
                <MenuPicker
                  value={options.language}
                  options={languageOptions}
                  ariaLabel={t('browser.options.language')}
                  onValueChange={language => setOptions({ ...options, language })}
                />
              </div>
              <div className='ev-setting-row'>
                <div className='ev-setting-copy'>
                  <strong>{t('browser.options.theme')}</strong>
                  <small>{t('browser.options.themeDesc')}</small>
                </div>
                <MenuPicker
                  value={options.theme}
                  options={themeOptions}
                  ariaLabel={t('browser.options.theme')}
                  onValueChange={theme => setOptions({ ...options, theme })}
                />
              </div>
              <label className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong>{t('browser.options.showNewTabBookmarks')}</strong>
                  <small>{t('browser.options.showNewTabBookmarksDesc')}</small>
                </span>
                <input
                  type='checkbox'
                  checked={options.showNewTabBookmarks}
                  onChange={event =>
                    setOptions({ ...options, showNewTabBookmarks: event.target.checked })
                  }
                />
              </label>
              <div className='ev-setting-row ev-background-setting'>
                <div className='ev-setting-copy'>
                  <strong>{t('browser.options.background')}</strong>
                  <small>{backgroundImage?.name || t('browser.options.backgroundEmpty')}</small>
                </div>
                <div className='ev-background-controls'>
                  {backgroundImage && (
                    <div
                      className='ev-background-preview'
                      style={{ backgroundImage: `url(${JSON.stringify(backgroundImage.dataUrl)})` }}
                      aria-hidden='true'
                    />
                  )}
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => backgroundFileRef.current?.click()}>
                    <ImageIcon size={14} /> {t('browser.options.chooseImage')}
                  </Button>
                  {backgroundImage && (
                    <Button
                      variant='ghost'
                      size='icon'
                      onClick={() => void clearBackgroundImage()}
                      aria-label={t('browser.options.clearImage')}
                      title={t('browser.options.clearImage')}>
                      <Trash2 size={14} />
                    </Button>
                  )}
                  <input
                    ref={backgroundFileRef}
                    className='sr-only'
                    type='file'
                    accept='image/*'
                    onChange={event => void selectBackgroundImage(event)}
                    aria-label={t('browser.options.backgroundFile')}
                  />
                </div>
              </div>
              {backgroundImage && options.background.type === 'image' && (
                <label className='ev-background-opacity'>
                  <span>{t('browser.options.backgroundIntensity')}</span>
                  <input
                    type='range'
                    min='20'
                    max='100'
                    step='1'
                    value={options.background.opacity}
                    onChange={event =>
                      setOptions({
                        ...options,
                        background: {
                          ...options.background,
                          opacity: Number(event.target.value),
                        },
                      })
                    }
                  />
                  <output>{options.background.opacity}%</output>
                </label>
              )}
              <div className='ev-setting-row'>
                <div className='ev-setting-copy'>
                  <strong>{t('browser.options.sortOrder')}</strong>
                  <small>{t('browser.options.sortOrderDesc')}</small>
                </div>
                <MenuPicker
                  value={options.sortBy}
                  options={sortOptions}
                  ariaLabel={t('browser.options.sortOrder')}
                  onValueChange={sortBy => setOptions({ ...options, sortBy })}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2'>
                <Cable size={15} /> {t('browser.options.bridge')}
              </CardTitle>
              <CardDescription>{t('browser.options.bridgeDesc')}</CardDescription>
            </CardHeader>
            <CardContent className='space-y-3'>
              <div className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong>{t('browser.options.bridgeEnable')}</strong>
                  <small>{t('browser.options.bridgeEnableDesc')}</small>
                </span>
                <span className='ev-status-pill'>{t('browser.options.capabilityEnabled')}</span>
              </div>

              <div className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong>{t('browser.options.pageActions')}</strong>
                  <small>{t('browser.options.pageActionsDesc')}</small>
                </span>
                <span className='ev-status-pill'>{t('browser.options.capabilityEnabled')}</span>
              </div>

              <label className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong>{t('browser.options.actionHighlight')}</strong>
                  <small>{t('browser.options.actionHighlightDesc')}</small>
                </span>
                <input
                  type='checkbox'
                  checked={options.actionHighlight}
                  onChange={event =>
                    setOptions({ ...options, actionHighlight: event.target.checked })
                  }
                />
              </label>

              <div className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong className='flex items-center gap-2'>
                    <Download size={14} /> {t('browser.options.mediaDownloads')}
                  </strong>
                  <small>{t('browser.options.mediaDownloadsDesc')}</small>
                </span>
                <span className='ev-status-pill'>{t('browser.options.capabilityEnabled')}</span>
              </div>

              <div className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong>{t('browser.options.connectionStatus')}</strong>
                  <small>{t(`browser.status.${bridgeStatus}`)}</small>
                </span>
                <div className='ev-background-controls'>
                  <Button variant='outline' size='sm' onClick={() => void refreshBridgeStatus()}>
                    {t('browser.options.refreshStatus')}
                  </Button>
                  <Button variant='outline' size='sm' onClick={() => void reconnectBridge()}>
                    {t('browser.options.requestReconnect')}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <footer className='ev-settings-footer'>
            {status && <span className='ev-settings-status'>{status}</span>}
            <Button onClick={saveOptions}>{t('browser.options.saveSettings')}</Button>
          </footer>
        </div>
      </div>
    </main>
  );
};

const rootElement = typeof document === 'undefined' ? null : document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <I18nextProvider i18n={i18n}>
      <OptionsPage />
    </I18nextProvider>
  );
}
