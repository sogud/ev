import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The EV server's dev CORS whitelist covers exactly this origin
// (apps/server/src/server.ts: DEV_ORIGINS), so keep it pinned. Open the web
// form with an explicit `?port=<port>&token=<token>` URL; the dev server never
// reads or exposes the operator token itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
});
