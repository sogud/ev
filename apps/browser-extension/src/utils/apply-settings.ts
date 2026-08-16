import { readSavedBackgroundImage } from '../shared/background-image';
import type { Options } from '../types';

export function applyThemePreference(theme: Options['theme']): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme === 'light' || theme === 'dark') root.classList.add(theme);
}

/** Apply persisted appearance settings to the current extension page. */
export const applyCustomSettings = (settings: Options) => {
  applyThemePreference(settings.theme);

  // Apply UI customization
  if (settings.uiCustomization) {
    // Update body class for compact mode
    if (settings.uiCustomization.compactMode) {
      document.body.classList.add('compact-mode');
    } else {
      document.body.classList.remove('compact-mode');
    }

    // Update body class for card style
    document.body.classList.remove('card-style-modern', 'card-style-minimal', 'card-style-glass');
    document.body.classList.add(`card-style-${settings.uiCustomization.cardStyle}`);

    // Update animation preference
    if (!settings.uiCustomization.animationEnabled) {
      document.body.classList.add('no-animations');
    } else {
      document.body.classList.remove('no-animations');
    }
  }
};

export async function applySavedBackground(settings: Options): Promise<void> {
  const root = document.documentElement;
  const savedImage = settings.background.type === 'image' ? await readSavedBackgroundImage() : null;
  const isTransparent =
    settings.background.type === 'color' && settings.background.value === 'transparent';
  let background = 'none';
  if (savedImage) {
    background = `url(${JSON.stringify(savedImage.dataUrl)})`;
  } else if (settings.background.type !== 'image' && !isTransparent) {
    background = settings.background.value;
  }
  const hasCustomBackground = background !== 'none';

  root.classList.toggle('ev-has-custom-background', hasCustomBackground);
  root.style.setProperty('--custom-background', background);
  root.style.setProperty(
    '--custom-background-opacity',
    hasCustomBackground ? (settings.background.opacity / 100).toString() : '0'
  );
}
