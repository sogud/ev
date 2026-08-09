import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'src/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/out/**',
        '**/build/**',
        '**/coverage/**',
        '**/tests/**',
        '**/*.{test,spec}.{ts,tsx}',
        '**/*.config.{js,ts}',
      ],
    },
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src/renderer/src'),
      '@main': resolve(__dirname, './src/main'),
      '@preload': resolve(__dirname, './src/preload'),
    },
  },
});
