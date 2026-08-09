import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// /m 独立入口：base '/m/' 让 index.html 的资产 URL 直接落在 server 的 /m/* 静态路由上。
export default defineConfig({
  base: '/m/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../desktop/dist-mobile', import.meta.url)),
    emptyOutDir: true,
  },
});
