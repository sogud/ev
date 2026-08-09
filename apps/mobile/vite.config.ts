import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Standalone /m entry: base '/m/' so index.html asset URLs land on the server's /m/* static route.
export default defineConfig({
  base: '/m/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../desktop/dist-mobile', import.meta.url)),
    emptyOutDir: true,
  },
});
