import { readSavedBackgroundImage } from '../shared/background-image';
import type { Options } from '../types';

export function applyThemePreference(theme: Options['theme']): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme === 'light' || theme === 'dark') root.classList.add(theme);
}

/** Apply persisted appearance settings to the current extension page. */
export const applyCustomSettings = (settings: Options) => {
  const root = document.documentElement;
  applyThemePreference(settings.theme);

  // Apply background
  if (settings.background) {
    let backgroundValue = 'none';

    switch (settings.background.type) {
      case 'gradient':
        backgroundValue = settings.background.value;
        break;
      case 'color':
        backgroundValue = settings.background.value;
        break;
      case 'image':
        backgroundValue = 'none';
        break;
    }

    root.style.setProperty('--custom-background', backgroundValue);
    root.style.setProperty(
      '--custom-background-opacity',
      (settings.background.opacity / 100).toString()
    );
  }

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

  root.classList.toggle('ev-has-custom-background', Boolean(savedImage));
  root.style.setProperty(
    '--custom-background',
    savedImage ? `url(${JSON.stringify(savedImage.dataUrl)})` : 'none'
  );
  root.style.setProperty(
    '--custom-background-opacity',
    savedImage ? (settings.background.opacity / 100).toString() : '0'
  );
}
