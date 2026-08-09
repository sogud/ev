import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { MenuPicker } from '../../components/ui/menu-picker';
import type { Options as OptionsType } from '../../types';
import { Cable, Download, Image as ImageIcon, Palette, Settings, Trash2 } from 'lucide-react';
import { applyCustomSettings, applyThemePreference } from '../../utils/apply-settings';
import {
  readBackgroundImageFile,
  readSavedBackgroundImage,
  removeBackgroundImage,
  saveBackgroundImage,
  type SavedBackgroundImage,
} from '../../shared/background-image';
import {
  BROWSER_CONTROL_ORIGINS,
  DESKTOP_BRIDGE_CONFIG_KEY,
} from '../../shared/desktop-bridge-config';
import '../../globals.css';

interface BridgeSettings {
  enabled: boolean;
}

type BridgeStatus = 'disabled' | 'connecting' | 'pairing' | 'connected' | 'disconnected';

const BRIDGE_STATUS_LABELS: Record<BridgeStatus, string> = {
  disabled: 'Disabled',
  connecting: 'Connecting',
  pairing: 'Waiting for desktop approval',
  connected: 'Connected',
  disconnected: 'Disconnected',
};

function isBridgeStatus(value: unknown): value is BridgeStatus {
  return typeof value === 'string' && value in BRIDGE_STATUS_LABELS;
}

const THEME_OPTIONS: Array<{ value: OptionsType['theme']; label: string }> = [
  { value: 'auto', label: 'Follow system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const SORT_OPTIONS: Array<{ value: OptionsType['sortBy']; label: string }> = [
  { value: 'name', label: 'By name' },
  { value: 'date', label: 'By date' },
  { value: 'url', label: 'By URL' },
];

const OptionsPage = () => {
  const [options, setOptions] = useState<OptionsType>({
    theme: 'auto',
    sortBy: 'name',
    iconColor: {
      bookmark: '#737373',
      folder: '#737373',
    },
    background: {
      type: 'color',
      value: 'transparent',
      opacity: 100,
    },
    uiCustomization: {
      cardStyle: 'minimal',
      animationEnabled: true,
      compactMode: true,
    },
  });
  const [bridge, setBridge] = useState<BridgeSettings>({ enabled: true });
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>('connecting');
  const [browserControlAllowed, setBrowserControlAllowed] = useState(false);
  const [mediaDownloadsAllowed, setMediaDownloadsAllowed] = useState(false);
  const [backgroundImage, setBackgroundImage] = useState<SavedBackgroundImage | null>(null);
  const [status, setStatus] = useState<string>('');
  const backgroundFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void Promise.all([
      chrome.storage.sync.get({
        theme: 'auto',
        sortBy: 'name',
        iconColor: { bookmark: '#737373', folder: '#737373' },
        background: {
          type: 'color',
          value: 'transparent',
          opacity: 100,
        },
        uiCustomization: { cardStyle: 'minimal', animationEnabled: true, compactMode: true },
      }),
      chrome.storage.local.get(DESKTOP_BRIDGE_CONFIG_KEY),
      chrome.runtime.sendMessage({ action: 'bridge.status' }),
      chrome.permissions.contains({ origins: BROWSER_CONTROL_ORIGINS }),
      chrome.permissions.contains({ permissions: ['downloads'] }),
      readSavedBackgroundImage(),
    ]).then(
      ([appearance, local, bridgeState, hasBrowserControl, hasMediaDownloads, savedBackground]) => {
        setOptions(appearance as OptionsType);
        const savedBridge = local[DESKTOP_BRIDGE_CONFIG_KEY];
        if (savedBridge && typeof savedBridge === 'object') {
          setBridge(current => ({ ...current, ...(savedBridge as Partial<BridgeSettings>) }));
        }
        if (bridgeState?.success && isBridgeStatus(bridgeState.status)) {
          setBridgeStatus(bridgeState.status);
        }
        setBrowserControlAllowed(hasBrowserControl);
        setMediaDownloadsAllowed(hasMediaDownloads);
        setBackgroundImage(savedBackground);
      }
    );
  }, []);

  useEffect(() => {
    applyThemePreference(options.theme);
  }, [options.theme]);

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
      setStatus('Background image applied');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not read the background image');
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
    setStatus('Background image cleared');
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
    const requestedPermissions: chrome.permissions.Permissions = {
      origins: browserControlAllowed ? BROWSER_CONTROL_ORIGINS : [],
      permissions: mediaDownloadsAllowed ? ['downloads'] : [],
    };
    if (browserControlAllowed || mediaDownloadsAllowed) {
      const granted = await chrome.permissions.request(requestedPermissions);
      if (!granted) {
        setStatus(
          'Page actions or media download permission was not granted; other settings were not saved'
        );
        return;
      }
    }
    if (!browserControlAllowed) {
      await chrome.permissions.remove({ origins: BROWSER_CONTROL_ORIGINS });
    }
    if (!mediaDownloadsAllowed) {
      await chrome.permissions.remove({ permissions: ['downloads'] });
    }

    await Promise.all([
      chrome.storage.sync.set(options),
      chrome.storage.local.set({ [DESKTOP_BRIDGE_CONFIG_KEY]: bridge }),
    ]);
    applyCustomSettings(options);
    setStatus('Settings saved');
    window.setTimeout(() => setStatus(''), 2000);
  };

  return (
    <main className='ev-options-page'>
      <div className='ev-options-shell'>
        <header className='ev-page-header'>
          <h1 className='ev-page-title'>
            <Settings size={18} /> EV Browser settings
          </h1>
          <p className='ev-page-description'>
            Manage appearance, sorting and Desktop Bridge permissions.
          </p>
        </header>

        <div className='ev-settings-stack'>
          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2'>
                <Palette size={15} /> Appearance
              </CardTitle>
              <CardDescription>Shares theme and compact density with EV Desktop.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className='ev-setting-row'>
                <div className='ev-setting-copy'>
                  <strong>Theme</strong>
                  <small>Light, dark, or follow the system</small>
                </div>
                <MenuPicker
                  value={options.theme}
                  options={THEME_OPTIONS}
                  ariaLabel='UI theme'
                  onValueChange={theme => setOptions({ ...options, theme })}
                />
              </div>
              <div className='ev-setting-row ev-background-setting'>
                <div className='ev-setting-copy'>
                  <strong>Full-page background</strong>
                  <small>
                    {backgroundImage?.name ?? 'Upload a local image to cover the new tab page'}
                  </small>
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
                    <ImageIcon size={14} /> Choose image
                  </Button>
                  {backgroundImage && (
                    <Button
                      variant='ghost'
                      size='icon'
                      onClick={() => void clearBackgroundImage()}
                      aria-label='Clear background image'
                      title='Clear background image'>
                      <Trash2 size={14} />
                    </Button>
                  )}
                  <input
                    ref={backgroundFileRef}
                    className='sr-only'
                    type='file'
                    accept='image/*'
                    onChange={event => void selectBackgroundImage(event)}
                    aria-label='Background image file'
                  />
                </div>
              </div>
              {backgroundImage && options.background.type === 'image' && (
                <label className='ev-background-opacity'>
                  <span>Background intensity</span>
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
                  <strong>Sort order</strong>
                  <small>Default bookmark order on the new tab page</small>
                </div>
                <MenuPicker
                  value={options.sortBy}
                  options={SORT_OPTIONS}
                  ariaLabel='Bookmark sort order'
                  onValueChange={sortBy => setOptions({ ...options, sortBy })}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2'>
                <Cable size={15} /> Desktop Bridge
              </CardTitle>
              <CardDescription>
                Discovers the local EV Desktop automatically; the first connection only needs
                approval on the desktop.
              </CardDescription>
            </CardHeader>
            <CardContent className='space-y-3'>
              <label className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong>Enable Desktop Bridge</strong>
                  <small>
                    Address and token are managed automatically by the extension and the desktop
                  </small>
                </span>
                <input
                  type='checkbox'
                  checked={bridge.enabled}
                  onChange={event => setBridge({ ...bridge, enabled: event.target.checked })}
                />
              </label>

              <label className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong>Allow page actions</strong>
                  <small>On save, the browser shows the optional host permission prompt</small>
                </span>
                <input
                  type='checkbox'
                  checked={browserControlAllowed}
                  onChange={event => setBrowserControlAllowed(event.target.checked)}
                />
              </label>

              <label className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong className='flex items-center gap-2'>
                    <Download size={14} /> Let the agent download media
                  </strong>
                  <small>
                    Saved to an EV subdirectory of the browser default download folder; DRM content
                    is not supported
                  </small>
                </span>
                <input
                  type='checkbox'
                  checked={mediaDownloadsAllowed}
                  onChange={event => setMediaDownloadsAllowed(event.target.checked)}
                />
              </label>

              <div className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong>Connection status</strong>
                  <small>{BRIDGE_STATUS_LABELS[bridgeStatus]}</small>
                </span>
                <div className='ev-background-controls'>
                  <Button variant='outline' size='sm' onClick={() => void refreshBridgeStatus()}>
                    Refresh status
                  </Button>
                  <Button variant='outline' size='sm' onClick={() => void reconnectBridge()}>
                    Request reconnect
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <footer className='ev-settings-footer'>
            {status && <span className='ev-settings-status'>{status}</span>}
            <Button onClick={saveOptions}>Save settings</Button>
          </footer>
        </div>
      </div>
    </main>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<OptionsPage />);
