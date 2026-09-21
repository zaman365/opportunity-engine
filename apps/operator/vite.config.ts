import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The operator is a static bundle served from the same origin as the API, so there is no
 * CORS configuration anywhere: ADR-004 rules out permissive credentialed CORS, and
 * same-origin plus a session CSRF token is the whole story.
 *
 * In development Vite proxies /api and /public to the local API process, which keeps the
 * browser's notion of origin identical to production's. `/public` is the M3 requested-intake
 * surface; it is served by the API in every environment, and is proxied here only so a
 * developer poking at the local stack sees the same shape.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      '@oe/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN ?? 'http://127.0.0.1:4174',
        changeOrigin: false,
      },
      '/public': {
        target: process.env.API_ORIGIN ?? 'http://127.0.0.1:4174',
        changeOrigin: false,
      },
    },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
