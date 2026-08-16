/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{html,js,ts,jsx,tsx}',
    '../../packages/ui/src/**/*.{html,js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--ev-color-bg-canvas)',
        panel: 'var(--ev-color-bg-surface)',
        elevated: 'var(--ev-color-bg-raised)',
        line: 'var(--ev-color-border-default)',
        ink: 'var(--ev-color-text-primary)',
        muted: 'var(--ev-color-text-tertiary)',
        accent: 'var(--ev-color-text-link)',
        danger: 'var(--ev-color-status-danger)',
      },
      fontFamily: {
        sans: ['var(--ev-font-sans)'],
        mono: ['var(--ev-font-mono)'],
      },
    },
  },
  plugins: [],
};
