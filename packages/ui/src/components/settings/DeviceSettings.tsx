import type { DevicePresence } from '@ev/contracts';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const KIND_KEYS: Record<DevicePresence['kind'], string> = {
  desktop: 'devices.kindDesktop',
  web: 'devices.kindWeb',
  cli: 'devices.kindCli',
  unknown: 'devices.kindUnknown',
};

export function DeviceSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<DevicePresence[] | null>(null);

  useEffect(() => {
    let active = true;
    void window.agentDesktop.devices.list().then(list => {
      if (active) setDevices(list);
    });
    const off = window.agentDesktop.devices.onUpdate(list => {
      if (active) setDevices(list);
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  const seenText = (device: DevicePresence): string => {
    if (device.online) return t('devices.online');
    const minutes = Math.floor((Date.now() - device.lastSeenAt) / 60_000);
    if (minutes < 1) return t('devices.now');
    if (minutes < 60) return t('devices.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('devices.hoursAgo', { count: hours });
    return t('devices.daysAgo', { count: Math.floor(hours / 24) });
  };

  return (
    <div className='devices-page'>
      <div className='settings-page-heading'>
        <h2>{t('devices.title')}</h2>
        <p>{t('devices.desc')}</p>
      </div>
      {devices === null ? (
        <p className='muted settings-loading'>{t('devices.loading')}</p>
      ) : devices.length === 0 ? (
        <p className='muted'>{t('devices.empty')}</p>
      ) : (
        <div className='device-rows' role='list'>
          {devices.map(device => (
            <div className='device-row' role='listitem' key={device.id}>
              <span
                className={`device-dot${device.online ? ' online' : ''}`}
                aria-hidden='true'
              />
              <span className='device-name'>{device.name}</span>
              <span className='device-kind'>{t(KIND_KEYS[device.kind])}</span>
              <span className='device-seen muted'>{seenText(device)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
