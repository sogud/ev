import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only convenience: opening bare `http://localhost:5173/` redirects to the
 * running EV server recorded in ~/.ev/server.json (same discovery entry desktop
 * main uses), so dev never has to copy the port/token by hand. EV_HOME overrides
 * the data dir for isolated runs. Params already in the URL pass through as-is.
 */
function evAutoConnect(): Plugin {
  return {
    name: 'ev-auto-connect',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/' && req.url !== '/index.html') return next();
        const dir = process.env.EV_HOME?.trim() || join(homedir(), '.ev');
        const path = join(dir, 'server.json');
        let info: { port?: unknown; token?: unknown } | null = null;
        try {
          info = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          // No discovery record: fall through to the hint below.
        }
        if (typeof info?.port === 'number' && typeof info?.token === 'string') {
          res.writeHead(302, {
            location: `/?port=${info.port}&token=${encodeURIComponent(info.token)}`,
          });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(
          `EV server is not running (no ${path}). Start it first — open the EV desktop app or run the ev server — then reload.\n`
        );
      });
    },
  };
}

// The EV server's dev CORS whitelist covers exactly this origin
// (apps/server/src/server.ts: DEV_ORIGINS), so keep it pinned.
export default defineConfig({
  plugins: [react(), evAutoConnect()],
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
});
