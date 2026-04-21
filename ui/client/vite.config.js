import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  // base: './' is required when loading from Electron file:// URLs.
  // For browser dev-server (npm run dev) this has no effect on routing.
  base: './',

  server: {
    port: 5173,

    // ── Backend proxy ──────────────────────────────────────────────────────
    // ALL /api/* calls (including /api/proxy/* cloud routes) go to the local
    // Express server on port 3001. Express handles bot control AND proxies
    // cloud API requests server-to-server, eliminating all CORS issues.
    //
    // ui/server must be running: node ui/server/index.js
    // Cloud URL is configured in ui/server/.env → CLOUD_API_URL
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
      },
    },

  },
  // Vite's SPA mode (the default appType) already serves index.html for all
  // non-asset paths, so /auth/verified is handled without extra config.
});
