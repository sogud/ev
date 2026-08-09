import Store from './store';
import type { ThemePreference } from '@ev/contracts/domain';

export interface AppearanceStore {
  getTheme(): ThemePreference;
  setTheme(theme: ThemePreference): void;
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** 无头版：只记录偏好；主题应用由各客户端（desktop 窗壳/Web）自行完成。 */
export function createAppearanceStore(): AppearanceStore {
  const store = new Store<{ theme: ThemePreference }>({
    name: 'appearance',
    defaults: { theme: 'system' },
  });

  return {
    getTheme(): ThemePreference {
      const theme = store.get('theme');
      return isThemePreference(theme) ? theme : 'system';
    },
    setTheme(theme: ThemePreference): void {
      store.set('theme', theme);
    },
  };
}
