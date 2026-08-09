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
import { Options as OptionsType } from '../../types';
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
  disabled: '已停用',
  connecting: '连接中',
  pairing: '等待 Desktop 批准',
  connected: '已连接',
  disconnected: '已断开',
};

function isBridgeStatus(value: unknown): value is BridgeStatus {
  return typeof value === 'string' && value in BRIDGE_STATUS_LABELS;
}

const THEME_OPTIONS: Array<{ value: OptionsType['theme']; label: string }> = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const SORT_OPTIONS: Array<{ value: OptionsType['sortBy']; label: string }> = [
  { value: 'name', label: '按名称' },
  { value: 'date', label: '按日期' },
  { value: 'url', label: '按网址' },
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
      setStatus('背景图片已应用');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法读取背景图片');
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
    setStatus('背景图片已清除');
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
        setStatus('未获得网页操作或媒体下载权限，其他设置未保存');
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
    setStatus('设置已保存');
    window.setTimeout(() => setStatus(''), 2000);
  };

  return (
    <main className='ev-options-page'>
      <div className='ev-options-shell'>
        <header className='ev-page-header'>
          <h1 className='ev-page-title'>
            <Settings size={18} /> EV Browser 设置
          </h1>
          <p className='ev-page-description'>管理外观、排序与 Desktop Bridge 权限。</p>
        </header>

        <div className='ev-settings-stack'>
          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2'>
                <Palette size={15} /> 外观
              </CardTitle>
              <CardDescription>与 EV Desktop 使用相同的主题和紧凑密度。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className='ev-setting-row'>
                <div className='ev-setting-copy'>
                  <strong>主题</strong>
                  <small>浅色、深色或跟随系统</small>
                </div>
                <MenuPicker
                  value={options.theme}
                  options={THEME_OPTIONS}
                  ariaLabel='界面主题'
                  onValueChange={theme => setOptions({ ...options, theme })}
                />
              </div>
              <div className='ev-setting-row ev-background-setting'>
                <div className='ev-setting-copy'>
                  <strong>整页背景图</strong>
                  <small>{backgroundImage?.name ?? '上传本地图片，填满整个新标签页'}</small>
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
                    <ImageIcon size={14} /> 选择图片
                  </Button>
                  {backgroundImage && (
                    <Button
                      variant='ghost'
                      size='icon'
                      onClick={() => void clearBackgroundImage()}
                      aria-label='清除背景图片'
                      title='清除背景图片'>
                      <Trash2 size={14} />
                    </Button>
                  )}
                  <input
                    ref={backgroundFileRef}
                    className='sr-only'
                    type='file'
                    accept='image/*'
                    onChange={event => void selectBackgroundImage(event)}
                    aria-label='选择背景图片文件'
                  />
                </div>
              </div>
              {backgroundImage && options.background.type === 'image' && (
                <label className='ev-background-opacity'>
                  <span>背景强度</span>
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
                  <strong>排序方式</strong>
                  <small>新标签页中的默认书签顺序</small>
                </div>
                <MenuPicker
                  value={options.sortBy}
                  options={SORT_OPTIONS}
                  ariaLabel='书签排序方式'
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
                自动发现本机 EV Desktop，首次连接只需在 Desktop 批准。
              </CardDescription>
            </CardHeader>
            <CardContent className='space-y-3'>
              <label className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong>启用 Desktop Bridge</strong>
                  <small>地址和 token 由扩展与 Desktop 自动管理</small>
                </span>
                <input
                  type='checkbox'
                  checked={bridge.enabled}
                  onChange={event => setBridge({ ...bridge, enabled: event.target.checked })}
                />
              </label>

              <label className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong>允许操作网页</strong>
                  <small>保存时由浏览器显示 optional host permission 确认</small>
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
                    <Download size={14} /> 允许 Agent 下载媒体
                  </strong>
                  <small>保存到浏览器默认下载目录的 EV 子目录；不支持 DRM 内容</small>
                </span>
                <input
                  type='checkbox'
                  checked={mediaDownloadsAllowed}
                  onChange={event => setMediaDownloadsAllowed(event.target.checked)}
                />
              </label>

              <div className='ev-setting-row'>
                <span className='ev-setting-copy'>
                  <strong>连接状态</strong>
                  <small>{BRIDGE_STATUS_LABELS[bridgeStatus]}</small>
                </span>
                <div className='ev-background-controls'>
                  <Button variant='outline' size='sm' onClick={() => void refreshBridgeStatus()}>
                    刷新状态
                  </Button>
                  <Button variant='outline' size='sm' onClick={() => void reconnectBridge()}>
                    请求重连
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <footer className='ev-settings-footer'>
            {status && <span className='ev-settings-status'>{status}</span>}
            <Button onClick={saveOptions}>保存设置</Button>
          </footer>
        </div>
      </div>
    </main>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<OptionsPage />);
