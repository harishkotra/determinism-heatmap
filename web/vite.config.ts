import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Defaults are the mandated 5173 -> 3001 pair. Both are overridable so this
 * app can be run alongside another project that already holds those ports.
 */
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
const API_PORT = Number(process.env.API_PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});