import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@ev/contracts', '@ev/browser-host'] })],
    build: {
      outDir: 'dist-electron/main',
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react()],
    build: {
      outDir: 'dist-electron/renderer',
    },
    define: {
      __IS_ESM__: 'true',
    },
  },
});
