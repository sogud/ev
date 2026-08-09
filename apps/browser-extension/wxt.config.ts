import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'EV Browser',
    description: 'Local-first bookmarks and browser context for EV.',
    version: '1.0.0',
    permissions: [
      'activeTab',
      'bookmarks',
      ...(browser === 'chrome' ? (['debugger'] as const) : []),
      'history',
      'scripting',
      'storage',
      'tabs',
    ],
    optional_permissions: browser === 'chrome' ? ['downloads'] : [],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
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
