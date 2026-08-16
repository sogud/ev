import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'EV Browser',
    description: 'Local-first bookmarks and browser context for EV.',
    version: '1.0.0',
    permissions: [
      'bookmarks',
      'downloads',
      ...(browser === 'chrome' ? (['debugger', 'downloads.open'] as const) : []),
      'history',
      'scripting',
      'sessions',
      'storage',
      'tabGroups',
      'tabs',
    ],
    host_permissions: ['http://*/*', 'https://*/*'],
    icons: {
      16: '/icon-16.png',
      32: '/icon-32.png',
      48: '/icon-48.png',
      96: '/icon-96.png',
      128: '/icon.png',
    },
    action: {
      default_icon: {
        16: '/icon-16.png',
        32: '/icon-32.png',
        48: '/icon-48.png',
      },
    },
  }),
});
